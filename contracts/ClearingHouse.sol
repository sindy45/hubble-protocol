// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { ERC2771ContextUpgradeable } from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { VanillaGovernable } from "./Governable.sol";
import { IAMM, IInsuranceFund, IMarginAccount } from "./Interfaces.sol";
import { VUSD } from "./VUSD.sol";

contract ClearingHouse is VanillaGovernable, ERC2771ContextUpgradeable {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 constant PRECISION = 1e6;

    int256 public maintenanceMargin;
    uint public tradeFee;
    uint public liquidationPenalty;

    VUSD public vusd;
    IInsuranceFund public insuranceFund;
    IMarginAccount public marginAccount;
    IAMM[] public amms;

    event PositionModified(address indexed trader, uint indexed idx, int256 baseAssetQuantity, uint quoteAsset);
    event PositionLiquidated(address indexed trader, address indexed amm, int256 size, uint256 quoteAsset, int256 realizedPnl);
    event MarketAdded(address indexed amm);

    function initialize(
        address _trustedForwarder,
        address _governance,
        address _insuranceFund,
        address _marginAccount,
        address _vusd,
        int256 _maintenanceMargin,
        uint _tradeFee,
        uint _liquidationPenalty
    ) external {
        __ERC2771Context_init(_trustedForwarder); // has the initializer modifier
        _setGovernace(_governance);

        insuranceFund = IInsuranceFund(_insuranceFund);
        marginAccount = IMarginAccount(_marginAccount);
        vusd = VUSD(_vusd);

        require(_maintenanceMargin > 0, "_maintenanceMargin < 0");
        maintenanceMargin = _maintenanceMargin;
        tradeFee = _tradeFee;
        liquidationPenalty = _liquidationPenalty;
    }

    /**
    * @notice Open/Modify/Close Position
    * @param idx AMM index
    * @param baseAssetQuantity Quantity of the base asset to Long (baseAssetQuantity > 0) or Short (baseAssetQuantity < 0)
    * @param quoteAssetLimit Rate at which the trade is executed in the AMM. Used to cap slippage.
    */
    function openPosition(uint idx, int256 baseAssetQuantity, uint quoteAssetLimit) external {
        _openPosition(_msgSender(), idx, baseAssetQuantity, quoteAssetLimit);
    }

    function closePosition(uint idx, uint quoteAssetLimit) external {
        address trader = _msgSender();
        (int256 size,,) = amms[idx].positions(trader);
        _openPosition(trader, idx, -size, quoteAssetLimit);
    }

    function _openPosition(address trader, uint idx, int256 baseAssetQuantity, uint quoteAssetLimit) internal {
        require(baseAssetQuantity != 0, "CH: baseAssetQuantity == 0");

        updatePositions(trader); // adjust funding payments

        (int realizedPnl, uint quoteAsset, bool isPositionIncreased) = amms[idx].openPosition(trader, baseAssetQuantity, quoteAssetLimit);
        uint _tradeFee = _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, false /* isLiquidation */);
        marginAccount.transferOutVusd(address(insuranceFund), _tradeFee);

        if (isPositionIncreased) {
            require(isAboveMaintenanceMargin(trader), "CH: Below Maintenance Margin");
        }
        emit PositionModified(trader, idx, baseAssetQuantity, quoteAsset);
    }

    function addLiquidity(uint idx, uint256 baseAssetQuantity, uint minDToken) external {
        address maker = _msgSender();
        updatePositions(maker);
        amms[idx].addLiquidity(maker, baseAssetQuantity, minDToken);
        require(isAboveMaintenanceMargin(maker), "CH: Below Maintenance Margin");
    }

    function removeLiquidity(uint idx, uint256 amount, uint minQuoteValue, uint minBaseValue) external {
        address maker = _msgSender();
        updatePositions(maker);
        int256 realizedPnl = amms[idx].removeLiquidity(maker, amount, minQuoteValue, minBaseValue);
        marginAccount.realizePnL(maker, realizedPnl);
    }

    function liquidateMaker(address maker) external {
        updatePositions(maker);

        require(
            _calcMarginFraction(maker, false) < maintenanceMargin,
            "CH: Above Maintenance Margin"
        );

        int256 realizedPnl;
        for (uint i = 0; i < amms.length; i++) {
            (,, uint dToken,,,,) = amms[i].makers(maker);
            realizedPnl += amms[i].removeLiquidity(maker, dToken, 0, 0);
        }
        marginAccount.realizePnL(maker, realizedPnl);
    }

    function updatePositions(address trader) public {
        require(address(trader) != address(0), 'CH: 0x0 trader Address');
        int256 fundingPayment;
        for (uint i = 0; i < amms.length; i++) {
            fundingPayment += amms[i].updatePosition(trader);
        }
        // -ve fundingPayment means trader should receive funds
        marginAccount.realizePnL(trader, -fundingPayment);
    }

    function settleFunding() external {
        for (uint i = 0; i < amms.length; i++) {
            amms[i].settleFunding();
        }
    }

    /**
    @notice Wooosh, you are now liquidate
    */
    function liquidate(address trader) public {
        require(!hasLiquidity(trader), 'CH: Remove Liquidity First');
        updatePositions(trader);
        require(_calcMarginFraction(trader, false /* check funding payments again */) < maintenanceMargin, "Above Maintenance Margin");
        int realizedPnl;
        uint quoteAsset;
        int256 size;
        IAMM _amm;
        for (uint i = 0; i < amms.length; i++) { // liquidate all positions
            _amm = amms[i];
            (size,,) = _amm.positions(trader);
            if (size != 0) {
                (int _realizedPnl, uint _quoteAsset) = _amm.liquidatePosition(trader);
                realizedPnl += _realizedPnl;
                quoteAsset += _quoteAsset;
                emit PositionLiquidated(trader, address(_amm), size, _quoteAsset, _realizedPnl);
            }
        }
        // extra liquidation penalty
        uint _liquidationFee = _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, true /* isLiquidation */);
        if (_liquidationFee > 0) {
            uint _toInsurance = _liquidationFee / 2;
            marginAccount.transferOutVusd(address(insuranceFund), _toInsurance);
            marginAccount.transferOutVusd(_msgSender(), _liquidationFee - _toInsurance);
        }
    }

    function liquidateMany(address[] calldata traders) external {
        for (uint i = 0; i < traders.length; i++) {
            liquidate(traders[i]);
        }
    }

    function _chargeFeeAndRealizePnL(
        address trader,
        int realizedPnl,
        uint quoteAsset,
        bool isLiquidation
    )
        internal
        returns (uint fee)
    {
        fee = isLiquidation ? _calculateLiquidationPenalty(quoteAsset) : _calculateTradeFee(quoteAsset);
        int256 marginCharge = realizedPnl - fee.toInt256();
        if (marginCharge != 0) {
            marginAccount.realizePnL(trader, marginCharge);
        }
    }

    // View

    function isAboveMaintenanceMargin(address trader) public view returns(bool) {
        return getMarginFraction(trader) >= maintenanceMargin;
    }

    function getMarginFraction(address trader) public view returns(int256) {
        return _calcMarginFraction(trader, true /* includeFundingPayments */);
    }

    function hasLiquidity(address trader) public view returns(bool) {
        for (uint i = 0; i < amms.length; i++) {
            (,, uint dToken,,,,) = amms[i].makers(trader);
            if (dToken > 0) {
                return true;
            }
        }
        return false;
    }

    function getTotalFunding(address trader) public view returns(int256 totalFunding) {
        int256 takerFundingPayment;
        int256 makerFundingPayment;
        for (uint i = 0; i < amms.length; i++) {
            (takerFundingPayment, makerFundingPayment,,) = amms[i].getPendingFundingPayment(trader);
            totalFunding += (takerFundingPayment + makerFundingPayment);
        }
    }

    function getTotalNotionalPositionAndUnrealizedPnl(address trader)
        public
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl)
    {
        uint256 _notionalPosition;
        int256 _unrealizedPnl;
        for (uint i = 0; i < amms.length; i++) {
            (_notionalPosition, _unrealizedPnl,,) = amms[i].getNotionalPositionAndUnrealizedPnl(trader);
            notionalPosition += _notionalPosition;
            unrealizedPnl += _unrealizedPnl;
        }
    }

    function getAmmsLength() external view returns(uint) {
        return amms.length;
    }

    // Internal View

    function _calculateTradeFee(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * tradeFee / PRECISION;
    }

    function _calculateLiquidationPenalty(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * liquidationPenalty / PRECISION;
    }

    function _calcMarginFraction(address trader, bool includeFundingPayments) internal view returns(int256) {
        (uint256 notionalPosition, int256 margin) = getNotionalPositionAndMargin(trader, includeFundingPayments);
        return _getMarginFraction(margin, notionalPosition);
    }

    function getNotionalPositionAndMargin(address trader, bool includeFundingPayments)
        public
        view
        returns(uint256 notionalPosition, int256 margin)
    {
        int256 unrealizedPnl;
        (notionalPosition, unrealizedPnl) = getTotalNotionalPositionAndUnrealizedPnl(trader);
        margin = marginAccount.getNormalizedMargin(trader);
        margin += unrealizedPnl;
        if (includeFundingPayments) {
            margin -= getTotalFunding(trader); // -ve fundingPayment means trader should receive funds
        }
    }

    // Pure

    function _getMarginFraction(int256 accountValue, uint notionalPosition) private pure returns(int256) {
        if (notionalPosition == 0) {
            return type(int256).max;
        }
        return accountValue * PRECISION.toInt256() / notionalPosition.toInt256();
    }

    // Governance

    function whitelistAmm(address _amm) external onlyGovernance {
        amms.push(IAMM(_amm));
        emit MarketAdded(_amm);
    }
}
