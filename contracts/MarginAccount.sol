// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { Governable } from "./Governable.sol";
import { ERC20Detailed, IClearingHouse, IInsuranceFund, IOracle, IRegistry } from "./Interfaces.sol";
import { VUSD } from "./VUSD.sol";

contract MarginAccount is Governable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    IClearingHouse public clearingHouse;
    IOracle public oracle;
    IInsuranceFund public insuranceFund;
    VUSD public vusd;

    struct Collateral {
        IERC20 token;
        uint weight;
        uint8 decimals;
    }
    Collateral[] public supportedCollateral;

    uint constant VUSD_IDX = 0;
    uint constant PRECISION = 1e6;

    uint public liquidationIncentive;

    // supportedCollateral index => trader => balance
    mapping(uint => mapping(address => int)) public margin;

    // Events

    event MarginAdded(address indexed trader, uint256 indexed idx, uint amount);
    event MarginRemoved(address indexed trader, uint256 indexed idx, uint256 amount);
    event PnLRealized(address indexed trader, int256 realizedPnl);
    event MarginAccountLiquidated(address indexed trader, uint indexed idx, uint seizeAmount, uint repayAmount);
    event SettledBadDebt(address indexed trader, uint badDebt, uint[] seized);

    modifier onlyClearingHouse() {
        require(msg.sender == address(clearingHouse), "Only clearingHouse");
        _;
    }

    function initialize(address _governance, address _vusd) external initializer {
        _setGovernace(_governance);
        _addCollateral(_vusd, PRECISION); // weight = 1 * PRECISION
        vusd = VUSD(_vusd);
    }

    // Add Margin functions

    function addMargin(uint idx, uint amount) external {
        addMarginFor(idx, amount, msg.sender);
    }

    function addMarginFor(uint idx, uint amount, address to) public {
        require(amount > 0, "Add non-zero margin");
        // will revert for idx >= supportedCollateral.length
        supportedCollateral[idx].token.safeTransferFrom(msg.sender, address(this), amount);
        margin[idx][to] += amount.toInt256();
        emit MarginAdded(to, idx, amount);
    }

    function removeMargin(uint idx, uint256 amount) external {
        address trader = msg.sender;
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
        int vusdBal = margin[VUSD_IDX][trader];

        if (vusdBal >= 0) { // nothing to liquidate
            return (false, 0, 0);
        }

        (int256 notionalPosition,) = clearingHouse.getTotalNotionalPositionAndUnrealizedPnl(trader);
        if (notionalPosition != 0) { // Liquidate positions before liquidating margin account
            return (false, 0, 0);
        }

        (int256 weighted, int256 spot) = weightedAndSpotCollateral(trader);
        if (spot <= 0) {
            /**
                Liquidation scenario C, where Cusd < |vUSD|
                => Cusd - |vUSD| < 0
                => Cusd + vUSD < 0; since vUSD < 0
                Since the protocol is already in deficit we don't have any money to give out as liquidationIncentive
            */
            return (true, (-vusdBal).toUint256(), 0);
        }

        if (weighted < 0) {
            /**
                Liquidation scenario B, where Cw < |vUSD| <= Cusd
                => Cw - |vUSD| < 0
                => Cw + vUSD < 0; since vUSD < 0
                Max possible liquidationIncentive is Cusd - |vUSD| = Cusd + vUSD = spot
            */
            incentivePerDollar = spot.toUint256() * PRECISION / (-vusdBal).toUint256();
            if (incentivePerDollar > liquidationIncentive) {
                incentivePerDollar = liquidationIncentive;
            }
            return (true, (-vusdBal).toUint256(), incentivePerDollar);
        }

        return (false, 0, 0);
    }

    function liquidate(address trader, uint repayAmount, uint idx, uint minSeizeAmount) external {
        (bool _isLiquidatable,,uint incentivePerDollar) = isLiquidatable(trader);
        if (!_isLiquidatable) {
            revert("trader is above liquidation threshold or has open positions");
        }

        int vusdBal = margin[VUSD_IDX][trader];
        require((-vusdBal).toUint256() >= repayAmount, "repaying too much"); // @todo partial liquidation?

        Collateral memory coll = supportedCollateral[idx];
        int priceCollateral = oracle.getUnderlyingPrice(address(coll.token));
        uint seizeAmount = repayAmount * (PRECISION + incentivePerDollar) / priceCollateral.toUint256(); // scaled 6 decimals
        if (coll.decimals > 6) {
            seizeAmount *= (10 ** (coll.decimals - 6));
        }
        if (seizeAmount > margin[idx][trader].toUint256()) {
            seizeAmount = margin[idx][trader].toUint256();
        }
        require(seizeAmount >= minSeizeAmount, "Not seizing enough");

        margin[VUSD_IDX][trader] += repayAmount.toInt256();
        margin[idx][trader] -= seizeAmount.toInt256();
        supportedCollateral[VUSD_IDX].token.safeTransferFrom(msg.sender, address(this), repayAmount);
        supportedCollateral[idx].token.safeTransfer(msg.sender, seizeAmount);
        emit MarginAccountLiquidated(trader, repayAmount, idx, seizeAmount);
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
        for (uint i = 0; i < length; i++) {
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
