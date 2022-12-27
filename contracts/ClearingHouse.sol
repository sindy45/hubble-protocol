// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { HubbleBase } from "./legos/HubbleBase.sol";
import { IAMM, IInsuranceFund, IMarginAccount, IClearingHouse, IHubbleReferral } from "./Interfaces.sol";
import { VUSD } from "./VUSD.sol";

contract ClearingHouse is IClearingHouse, HubbleBase {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 constant PRECISION = 1e6;

    int256 override public maintenanceMargin;
    uint override public tradeFee;
    uint override public liquidationPenalty;
    int256 public minAllowableMargin;
    uint public referralShare;
    uint public tradingFeeDiscount;

    VUSD public vusd;
    IInsuranceFund override public insuranceFund;
    IMarginAccount public marginAccount;
    IAMM[] override public amms;
    IHubbleReferral public hubbleReferral;

    uint256[50] private __gap;

    event PositionModified(address indexed trader, uint indexed idx, int256 baseAsset, uint quoteAsset, int256 realizedPnl, uint256 timestamp);
    event PositionLiquidated(address indexed trader, uint indexed idx, int256 baseAsset, uint256 quoteAsset, int256 realizedPnl, uint256 timestamp);
    event PositionTranslated(address indexed trader, uint indexed idx, int256 baseAsset, uint256 quoteAsset, int256 realizedPnl, uint256 timestamp);
    event MarketAdded(uint indexed idx, address indexed amm);
    event ReferralBonusAdded(address indexed referrer, uint referralBonus);

    constructor(address _trustedForwarder) HubbleBase(_trustedForwarder) {}

    function initialize(
        address _governance,
        address _insuranceFund,
        address _marginAccount,
        address _vusd,
        address _hubbleReferral,
        int256 _maintenanceMargin,
        int256 _minAllowableMargin,
        uint _tradeFee,
        uint _referralShare,
        uint _tradingFeeDiscount,
        uint _liquidationPenalty
    ) external initializer {
        _setGovernace(_governance);

        insuranceFund = IInsuranceFund(_insuranceFund);
        marginAccount = IMarginAccount(_marginAccount);
        vusd = VUSD(_vusd);
        hubbleReferral = IHubbleReferral(_hubbleReferral);

        require(_maintenanceMargin > 0, "_maintenanceMargin < 0");
        maintenanceMargin = _maintenanceMargin;
        minAllowableMargin = _minAllowableMargin;
        tradeFee = _tradeFee;
        referralShare = _referralShare;
        tradingFeeDiscount = _tradingFeeDiscount;
        liquidationPenalty = _liquidationPenalty;
    }

    function executeMatchedOrders(
        uint idx,
        IAMM.Order[2] memory orders,
        bytes[2] memory signatures,
        int256 fillAmount
    ) external {
        // @todo validate that orders are matching
            // min fillAmount and min order.baseAsset check?

        // open position for order1
        _openPosition(idx, orders[0], signatures[0], fillAmount);
        // open position for order2
        _openPosition(idx, orders[1], signatures[1], fillAmount);
    }

    /* ****************** */
    /*     Positions      */
    /* ****************** */

    /**
    * @notice Open/Modify/Close Position
    * @param idx AMM index
    * @param order Order to be executed
    * @param signature Signature corresponding to the order
    */
    function _openPosition(uint idx, IAMM.Order memory order, bytes memory signature, int256 fillAmount) internal {
        require(order.baseAssetQuantity != 0 && fillAmount != 0, "CH: baseAssetQuantity == 0");

        updatePositions(order.trader); // adjust funding payments

        (int realizedPnl, uint quoteAsset, bool isPositionIncreased) = amms[idx].openPosition(order, signature, fillAmount);
        uint _tradeFee = _chargeFeeAndRealizePnL(order.trader, realizedPnl, quoteAsset, false /* isLiquidation */);
        marginAccount.transferOutVusd(address(insuranceFund), _tradeFee);

        if (isPositionIncreased) {
            assertMarginRequirement(order.trader);
        }
        emit PositionModified(order.trader, idx, fillAmount, quoteAsset, realizedPnl, _blockTimestamp());
    }

    /* ****************** */
    /*     Liquidity      */
    /* ****************** */
    function updatePositions(address trader) override public whenNotPaused {
        require(address(trader) != address(0), 'CH: 0x0 trader Address');
        int256 fundingPayment;
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            fundingPayment += amms[i].updatePosition(trader);
        }
        // -ve fundingPayment means trader should receive funds
        marginAccount.realizePnL(trader, -fundingPayment);
    }

    function settleFunding() override external whenNotPaused {
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            amms[i].settleFunding();
        }
    }

    /* ****************** */
    /*    Liquidations    */
    /* ****************** */

    function liquidate(address trader) override external whenNotPaused {
        updatePositions(trader);
        _liquidateTaker(trader);
    }

    // @todo redundant
    function liquidateTaker(address trader) override public whenNotPaused {
        updatePositions(trader);
        _liquidateTaker(trader);
    }

    /* ********************* */
    /* Liquidations Internal */
    /* ********************* */
    function _liquidateTaker(address trader) internal {
        _assertLiquidationRequirement(trader);
        int realizedPnl;
        uint quoteAsset;
        int256 size;
        IAMM _amm;
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) { // liquidate all positions
            _amm = amms[i];
            (size,,,) = _amm.positions(trader);
            if (size != 0) {
                (int _realizedPnl, int _baseAsset, uint _quoteAsset) = _amm.liquidatePosition(trader);
                realizedPnl += _realizedPnl;
                quoteAsset += _quoteAsset;
                emit PositionLiquidated(trader, i, _baseAsset, _quoteAsset, _realizedPnl, _blockTimestamp());
            }
        }

        _disperseLiquidationFee(
            _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, true /* isLiquidation */)
        );
    }

    function _disperseLiquidationFee(uint liquidationFee) internal {
        if (liquidationFee > 0) {
            uint toInsurance = liquidationFee / 2;
            marginAccount.transferOutVusd(address(insuranceFund), toInsurance);
            marginAccount.transferOutVusd(_msgSender(), liquidationFee - toInsurance);
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
        int256 marginCharge;
        if (isLiquidation) {
            fee = _calculateLiquidationPenalty(quoteAsset);
            marginCharge = realizedPnl - fee.toInt256();
        } else {
            fee = _calculateTradeFee(quoteAsset);

            address referrer = hubbleReferral.getTraderRefereeInfo(trader);
            uint referralBonus;
            if (referrer != address(0x0)) {
                referralBonus = quoteAsset * referralShare / PRECISION;
                // add margin to the referrer
                marginAccount.realizePnL(referrer, referralBonus.toInt256());
                emit ReferralBonusAdded(referrer, referralBonus);

                uint discount = quoteAsset * tradingFeeDiscount / PRECISION;
                fee -= discount;
            }
            marginCharge = realizedPnl - fee.toInt256();
            // deduct referral bonus from insurance fund share
            fee -= referralBonus;
        }
        marginAccount.realizePnL(trader, marginCharge);
    }

    /* ****************** */
    /*        View        */
    /* ****************** */

    function calcMarginFraction(address trader, bool includeFundingPayments, Mode mode) public view returns(int256) {
        (uint256 notionalPosition, int256 margin) = getNotionalPositionAndMargin(trader, includeFundingPayments, mode);
        return _getMarginFraction(margin, notionalPosition);
    }

    function getTotalFunding(address trader) override public view returns(int256 totalFunding) {
        int256 fundingPayment;
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            (fundingPayment,) = amms[i].getPendingFundingPayment(trader);
            if (fundingPayment < 0) {
                fundingPayment -= fundingPayment / 1e3; // receivers charged 0.1% to account for rounding-offs
            }
            totalFunding += fundingPayment;
        }
    }

    function getTotalNotionalPositionAndUnrealizedPnl(address trader, int256 margin, Mode mode)
        override
        public
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl)
    {
        uint256 _notionalPosition;
        int256 _unrealizedPnl;
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            if (amms[i].isOverSpreadLimit()) {
                (_notionalPosition, _unrealizedPnl) = amms[i].getOracleBasedPnl(trader, margin, mode);
            } else {
                (_notionalPosition, _unrealizedPnl,,) = amms[i].getNotionalPositionAndUnrealizedPnl(trader);
            }
            notionalPosition += _notionalPosition;
            unrealizedPnl += _unrealizedPnl;
        }
    }

    function getNotionalPositionAndMargin(address trader, bool includeFundingPayments, Mode mode)
        override
        public
        view
        returns(uint256 notionalPosition, int256 margin)
    {
        int256 unrealizedPnl;
        margin = marginAccount.getNormalizedMargin(trader);
        if (includeFundingPayments) {
            margin -= getTotalFunding(trader); // -ve fundingPayment means trader should receive funds
        }
        (notionalPosition, unrealizedPnl) = getTotalNotionalPositionAndUnrealizedPnl(trader, margin, mode);
        margin += unrealizedPnl;
    }

    function getAmmsLength() override public view returns(uint) {
        return amms.length;
    }

    function getAMMs() external view returns (IAMM[] memory) {
        return amms;
    }

    /* ****************** */
    /*   Test/UI Helpers  */
    /* ****************** */

    function isAboveMaintenanceMargin(address trader) override external view returns(bool) {
        return calcMarginFraction(trader, true, Mode.Maintenance_Margin) >= maintenanceMargin;
    }

    /**
    * @dev deprecated Use the nested call instead
    *   calcMarginFraction(trader, true, Mode.Min_Allowable_Margin)
    */
    function getMarginFraction(address trader) override external view returns(int256) {
        return calcMarginFraction(trader, true /* includeFundingPayments */, Mode.Min_Allowable_Margin);
    }

    /* ****************** */
    /*   Internal View    */
    /* ****************** */

    /**
    * @dev This method assumes that pending funding has been settled
    */
    function assertMarginRequirement(address trader) public view {
        require(
            calcMarginFraction(trader, false, Mode.Min_Allowable_Margin) >= minAllowableMargin,
            "CH: Below Minimum Allowable Margin"
        );
    }

    /**
    * @dev This method assumes that pending funding has been credited
    */
    function _assertLiquidationRequirement(address trader) internal view {
        require(calcMarginFraction(trader, false, Mode.Maintenance_Margin) < maintenanceMargin, "CH: Above Maintenance Margin");
    }

    function _calculateTradeFee(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * tradeFee / PRECISION;
    }

    function _calculateLiquidationPenalty(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * liquidationPenalty / PRECISION;
    }

    /* ****************** */
    /*        Pure        */
    /* ****************** */

    function _getMarginFraction(int256 accountValue, uint notionalPosition) private pure returns(int256) {
        if (notionalPosition == 0) {
            return type(int256).max;
        }
        return accountValue * PRECISION.toInt256() / notionalPosition.toInt256();
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function whitelistAmm(address _amm) external onlyGovernance {
        uint l = amms.length;
        for (uint i; i < l; ++i) {
            require(address(amms[i]) != _amm, "ch.whitelistAmm.duplicate_amm");
        }
        emit MarketAdded(l, _amm);
        amms.push(IAMM(_amm));
    }

    function setParams(
        int _maintenanceMargin,
        int _minAllowableMargin,
        uint _tradeFee,
        uint _liquidationPenalty,
        uint _referralShare,
        uint _tradingFeeDiscount
    ) external onlyGovernance {
        maintenanceMargin = _maintenanceMargin;
        minAllowableMargin = _minAllowableMargin;
        tradeFee = _tradeFee;
        liquidationPenalty = _liquidationPenalty;
        referralShare = _referralShare;
        tradingFeeDiscount = _tradingFeeDiscount;
    }
}
