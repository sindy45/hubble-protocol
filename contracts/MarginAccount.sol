// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { ERC2771ContextUpgradeable } from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import { VanillaGovernable } from "./Governable.sol";
import { ERC20Detailed, IClearingHouse, IInsuranceFund, IOracle, IRegistry } from "./Interfaces.sol";
import { VUSD } from "./VUSD.sol";

contract MarginAccount is VanillaGovernable, ERC2771ContextUpgradeable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint constant VUSD_IDX = 0;
    uint constant PRECISION = 1e6;

    // #### Structs ####

    struct Collateral {
        IERC20 token;
        uint weight;
        uint8 decimals;
    }

    struct LiquidationBuffer {
        uint incentivePerDollar;
        uint repayAble;
        uint priceCollateral;
        uint8 decimals;
    }

    // #### Storage ####

    IClearingHouse public clearingHouse;
    IOracle public oracle;
    IInsuranceFund public insuranceFund;
    VUSD public vusd;

    Collateral[] public supportedCollateral;

    uint public liquidationIncentive;

    // supportedCollateral index => trader => balance
    mapping(uint => mapping(address => int)) public margin;

    // #### ^^ Storage Ends ^^ ####

    // #### Events ####

    event MarginAdded(address indexed trader, uint256 indexed idx, uint amount);
    event MarginRemoved(address indexed trader, uint256 indexed idx, uint256 amount);
    event PnLRealized(address indexed trader, int256 realizedPnl);
    event MarginAccountLiquidated(address indexed trader, uint indexed idx, uint seizeAmount, uint repayAmount);
    event SettledBadDebt(address indexed trader, uint badDebt, uint[] seized);

    modifier onlyClearingHouse() {
        require(msg.sender == address(clearingHouse), "Only clearingHouse");
        _;
    }

    function initialize(address _trustedForwarder, address _governance, address _vusd) external {
        __ERC2771Context_init(_trustedForwarder); // has the initializer modifier
        _setGovernace(_governance);
        _addCollateral(_vusd, PRECISION); // weight = 1 * PRECISION
        vusd = VUSD(_vusd);
    }

    // Add Margin functions

    function addMargin(uint idx, uint amount) external {
        addMarginFor(idx, amount, _msgSender());
    }

    function addMarginFor(uint idx, uint amount, address to) public {
        require(amount > 0, "Add non-zero margin");
        // will revert for idx >= supportedCollateral.length
        supportedCollateral[idx].token.safeTransferFrom(_msgSender(), address(this), amount);
        margin[idx][to] += amount.toInt256();
        emit MarginAdded(to, idx, amount);
    }

    function removeMargin(uint idx, uint256 amount) external {
        address trader = _msgSender();
        clearingHouse.updatePositions(trader);
        require(margin[VUSD_IDX][trader] >= 0, "Cannot remove margin when vusd balance is negative");
        require(margin[idx][trader] >= amount.toInt256(), "Insufficient balance");

        margin[idx][trader] -= amount.toInt256();
        require(clearingHouse.isAboveMaintenanceMargin(trader), "CH: Below Maintenance Margin");

        if (idx == VUSD_IDX) {
            uint bal = vusd.balanceOf(address(this));
            if (bal < amount) {
                // Say there are 2 traders, Alice and Bob.
                // Alice has a profitable position and realizes their PnL in form of vusd margin.
                // But bob has not yet realized their -ve PnL.
                // In that case we'll take a credit from vusd contract, which will eventually be returned when Bob pays their debt back.
                vusd.mint(address(this), amount - bal);
            }
        }
        supportedCollateral[idx].token.safeTransfer(trader, amount);
        emit MarginRemoved(trader, idx, amount);
    }

    function realizePnL(address trader, int256 realizedPnl) onlyClearingHouse external {
        // -ve PnL will reduce balance
        margin[VUSD_IDX][trader] += realizedPnl;
        emit PnLRealized(trader, realizedPnl);
    }

    function isLiquidatable(address trader)
        public
        view
        returns(bool _isLiquidatable, uint repayAmount, uint incentivePerDollar)
    {
        return isLiquidatable_(trader, true);
    }

    function isLiquidatable_(address trader, bool includeFunding)
        internal
        view
        returns(bool _isLiquidatable, uint repay, uint incentivePerDollar)
    {
        int vusdBal = margin[VUSD_IDX][trader];
        if (includeFunding) {
            vusdBal -= clearingHouse.getTotalFunding(trader);
        }
        if (vusdBal >= 0) { // nothing to liquidate
            return (false, 0, 0);
        }

        (int256 notionalPosition,) = clearingHouse.getTotalNotionalPositionAndUnrealizedPnl(trader);
        if (notionalPosition != 0) { // Liquidate positions before liquidating margin account
            return (false, 0, 0);
        }

        (int256 weighted, int256 spot) = weightedAndSpotCollateral(trader);
        if (weighted >= 0) {
            return (false, 0, 0);
        }

        _isLiquidatable = true;
        repay = (-vusdBal).toUint256();
        incentivePerDollar = PRECISION;

        if (spot > 0) {
            /**
                Liquidation scenario B, where Cw < |vUSD| < Cusd
                => Cw - |vUSD| < 0
                => Cw + vUSD (weighted) < 0; since vUSD < 0
                Max possible liquidationIncentive (for repaying |vUSD|) is Cusd
            */
            incentivePerDollar += _min(
                liquidationIncentive, // 1.05
                spot.toUint256() * PRECISION / repay // (204+795) / 795
            );
        } /* else {
            /**
                Since the protocol is already in deficit we don't have any money to give out as liquidationIncentive
                Liquidation scenario C, where Cusd <= |vUSD|
                => Cusd - |vUSD| <= 0
                => Cusd + vUSD (spot) <= 0; since vUSD < 0
        } */
    }

    function liquidateExactRepay(address trader, uint repay, uint idx, uint minSeizeAmount) public {
        LiquidationBuffer memory buffer = _getLiquidationInfo(trader, idx);
        _liquidateExactRepay(buffer, trader, repay, idx, minSeizeAmount);
    }

    function liquidateExactSeize(address trader, uint maxRepay, uint idx, uint seize) public {
        LiquidationBuffer memory buffer = _getLiquidationInfo(trader, idx);
        _liquidateExactSeize(buffer, trader, maxRepay, idx, seize);
    }

    function liquidateFlexible(address trader, uint maxRepay, uint[] calldata idxs) external {
        uint repayed;
        uint repayAble;
        for (uint i = 0; i < idxs.length; i++) {
            maxRepay -= repayed;
            (repayed, repayAble) = _liquidateFlexible(trader, maxRepay, idxs[i]);
            if (repayAble == 0) break;
        }
    }

    function settleBadDebt(address trader) external {
        (int256 notionalPosition,) = clearingHouse.getTotalNotionalPositionAndUnrealizedPnl(trader);
        require(notionalPosition == 0, "Liquidate positions before settling bad debt");
        require(getSpotCollateralValue(trader) < 0, "Above bad debt threshold");
        int vusdBal = margin[VUSD_IDX][trader];
        require(vusdBal < 0, "Nothing to repay");

        uint badDebt = (-vusdBal).toUint256();
        Collateral[] memory assets = supportedCollateral;

        insuranceFund.seizeBadDebt(badDebt);
        margin[VUSD_IDX][trader] = 0;

        uint[] memory seized = new uint[](assets.length);
        for (uint i = 1 /* skip vusd */; i < assets.length; i++) {
            int amount = margin[i][trader];
            if (amount > 0) {
                margin[i][trader] = 0;
                assets[i].token.safeTransfer(address(insuranceFund), amount.toUint256());
                seized[i] = amount.toUint256();
            }
        }
        emit SettledBadDebt(trader, badDebt, seized);
    }

    // View

    function getSpotCollateralValue(address trader) public view returns(int256 spot) {
        (,spot) = weightedAndSpotCollateral(trader);
    }

    function getNormalizedMargin(address trader) public view returns(int256 weighted) {
        (weighted,) = weightedAndSpotCollateral(trader);
    }

    function weightedAndSpotCollateral(address trader)
        public
        view
        returns (int256 weighted, int256 spot)
    {
        Collateral[] memory assets = supportedCollateral;
        Collateral memory _collateral;

        for (uint i = 0; i < assets.length; i++) {
            _collateral = assets[i];

            int numerator = margin[i][trader] * oracle.getUnderlyingPrice(address(assets[i].token));
            uint denomDecimals = _collateral.decimals;

            spot += (numerator / int(10 ** denomDecimals));
            weighted += (numerator * _collateral.weight.toInt256() / int(10 ** (denomDecimals + 6)));
        }
    }

    // UI Helper functions

    function supportedAssets() external view returns (Collateral[] memory) {
        return supportedCollateral;
    }

    function userInfo(address trader) external view returns(int256[] memory) {
        uint length = supportedCollateral.length;
        int256[] memory _margin = new int256[](length);
        // -ve funding means user received funds
        _margin[VUSD_IDX] = margin[VUSD_IDX][trader] - clearingHouse.getTotalFunding(trader);
        for (uint i = 1; i < length; i++) {
            _margin[i] = margin[i][trader];
        }
        return _margin;
    }

    // Internal

    function _addCollateral(address _coin, uint _weight) internal {
        require(_weight <= PRECISION, "weight > 1e6");

        Collateral[] memory _collaterals = supportedCollateral;
        for (uint i = 0; i < _collaterals.length; i++) {
            require(address(_collaterals[i].token) != _coin, "collateral exists");
        }
        supportedCollateral.push(
            Collateral({
                token: IERC20(_coin),
                weight: _weight,
                decimals: ERC20Detailed(_coin).decimals() // will fail if .decimals() is not defined on the contract
            })
        );
    }

    /**
    * @notice This function wil either seize all available collateral of type idx
    * OR settle debt completely with (most likely) left over collateral
    */
    function _liquidateFlexible(address trader, uint maxRepay, uint idx) public returns(uint /* repayed */, uint /* repayAble */) {
        LiquidationBuffer memory buffer = _getLiquidationInfo(trader, idx);

        // Q. Can user's margin cover the entire debt?
        uint repay = _seizeToRepay(buffer, margin[idx][trader].toUint256());

        // A.1 Yes, it can cover the entire debt. Settle repayAble
        if (repay >= buffer.repayAble) {
            _liquidateExactRepay(
                buffer,
                trader,
                buffer.repayAble, // exact repay amount
                idx,
                0 // minSeizeAmount=0 implies accept whatever the oracle price is
            );
            return (buffer.repayAble, 0); // repayed exactly repayAble and 0 is left to repay now
        }

        // A.2 No, collateral can not cover the entire debt. Seize all of it.
        uint repayed = _liquidateExactSeize(
            buffer,
            trader,
            maxRepay,
            idx,
            margin[idx][trader].toUint256()
        );
        return (repayed, buffer.repayAble - repayed);
    }

    function _liquidateExactRepay(
        LiquidationBuffer memory buffer,
        address trader,
        uint repay,
        uint idx,
        uint minSeizeAmount
    )
        internal
        returns (uint seized)
    {
        seized = _min(
            _scaleDecimals(repay * buffer.incentivePerDollar, buffer.decimals - 6) / buffer.priceCollateral,
            margin[idx][trader].toUint256() // can't seize more than available
        );
        require(seized >= minSeizeAmount, "Not seizing enough");
        _executeLiquidation(trader, repay, idx, seized, buffer.repayAble);
    }

    function _liquidateExactSeize(
        LiquidationBuffer memory buffer,
        address trader,
        uint maxRepay,
        uint idx,
        uint seize
    )
        internal
        returns (uint /* repayed */)
    {
        uint repay = _seizeToRepay(buffer, seize);
        require(repay <= maxRepay, "Need to repay more to seize that much");
        _executeLiquidation(trader, repay, idx, seize, buffer.repayAble);
        return repay;
    }

    function _getLiquidationInfo(address trader, uint idx) internal returns (LiquidationBuffer memory buffer) {
        (buffer.repayAble, buffer.incentivePerDollar) = _checkLiquidationConditions(trader, idx);
        Collateral memory coll = supportedCollateral[idx];
        buffer.priceCollateral = oracle.getUnderlyingPrice(address(coll.token)).toUint256();
        buffer.decimals = coll.decimals;
    }

    function _checkLiquidationConditions(address trader, uint idx) internal returns (uint repayAble, uint incentivePerDollar) {
        require(idx > VUSD_IDX && idx < supportedCollateral.length, "collateral not seizable");
        clearingHouse.updatePositions(trader);  // credits/debits funding
        bool _isLiquidatable;
        (_isLiquidatable,repayAble,incentivePerDollar) = isLiquidatable_(trader, false);
        if (!_isLiquidatable) {
            revert("trader is above liquidation threshold or has open positions");
        }
    }

    function _executeLiquidation(address trader, uint repay, uint idx, uint seize, uint repayAble)
        internal
        returns (uint /* left over repayable */)
    {
        require(repayAble >= repay, "repaying more than the repayAble");
        margin[VUSD_IDX][trader] += repay.toInt256();
        margin[idx][trader] -= seize.toInt256();
        supportedCollateral[VUSD_IDX].token.safeTransferFrom(msg.sender, address(this), repay);
        supportedCollateral[idx].token.safeTransfer(msg.sender, seize);
        emit MarginAccountLiquidated(trader, idx, seize, repay);
        return repayAble - repay;
    }

    // Pure

    function _seizeToRepay(LiquidationBuffer memory buffer, uint seize) internal pure returns (uint repay) {
        repay = seize * buffer.priceCollateral / (10 ** buffer.decimals);
        if (buffer.incentivePerDollar > 0) {
            repay = repay * PRECISION / buffer.incentivePerDollar;
        }
    }

    function _scaleDecimals(uint256 amount, uint8 decimals) internal pure returns(uint256) {
        return amount *= (10 ** decimals);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // Governance

    function syncDeps(address _registry, uint _liquidationIncentive) public onlyGovernance {
        IRegistry registry = IRegistry(_registry);
        clearingHouse = IClearingHouse(registry.clearingHouse());
        oracle = IOracle(registry.oracle());
        insuranceFund = IInsuranceFund(registry.insuranceFund());
        liquidationIncentive = _liquidationIncentive;
    }

    // @todo rename to whitelistCollateral
    function addCollateral(address _coin, uint _weight) external onlyGovernance {
        _addCollateral(_coin, _weight);
    }

    // @todo function to change weight of an asset
}
