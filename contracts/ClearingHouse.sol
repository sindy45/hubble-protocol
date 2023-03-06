// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { HubbleBase } from "./legos/HubbleBase.sol";
import { IAMM, IMarginAccount, IClearingHouse, IHubbleReferral, IOrderBook } from "./Interfaces.sol";
import { VUSD } from "./VUSD.sol";

contract ClearingHouse is IClearingHouse, HubbleBase {
    using SafeCast for uint256;
    using SafeCast for int256;

    modifier onlyOrderBook() {
        require(msg.sender == address(orderBook), "Only orderBook");
        _;
    }

    uint256 constant PRECISION = 1e6;

    int256 override public maintenanceMargin;
    uint override public takerFee;
    uint override public makerFee;
    uint override public liquidationPenalty;
    int256 public minAllowableMargin;
    uint public referralShare;
    uint public tradingFeeDiscount;

    VUSD public vusd;
    address override public feeSink;
    IMarginAccount public marginAccount;
    IOrderBook public orderBook;
    IAMM[] override public amms;
    IHubbleReferral public hubbleReferral;

    uint256[50] private __gap;

    event PositionModified(address indexed trader, uint indexed idx, int256 baseAsset, uint quoteAsset, int256 realizedPnl, int256 size, uint256 openNotional, uint256 timestamp);
    event PositionLiquidated(address indexed trader, uint indexed idx, int256 baseAsset, uint256 quoteAsset, int256 realizedPnl, int256 size, uint256 openNotional, uint256 timestamp);
    event MarketAdded(uint indexed idx, address indexed amm);
    event ReferralBonusAdded(address indexed referrer, uint referralBonus);
    event FundingPaid(address indexed trader, uint indexed idx, int256 takerFundingPayment, int256 cumulativePremiumFraction);
    event FundingRateUpdated(uint indexed idx, int256 premiumFraction, uint256 underlyingPrice, int256 cumulativePremiumFraction, uint256 nextFundingTime, uint256 timestamp, uint256 blockNumber);

    constructor(address _trustedForwarder) HubbleBase(_trustedForwarder) {}

    function initialize(
        address _governance,
        address _feeSink,
        address _marginAccount,
        address _orderBook,
        address _vusd,
        address _hubbleReferral
    ) external
      // commenting this out only for a bit for testing because it doesn't let us initialize repeatedly unless we run a fresh subnet
      // initializer
    {
        _setGovernace(_governance);

        feeSink = _feeSink;
        marginAccount = IMarginAccount(_marginAccount);
        orderBook = IOrderBook(_orderBook);
        vusd = VUSD(_vusd);
        hubbleReferral = IHubbleReferral(_hubbleReferral);

        // resetting to handle re-deployments using proxy contracts
        delete amms;
    }

    /* ****************** */
    /*     Positions      */
    /* ****************** */

    /**
    * @notice Open/Modify/Close Position
    * @param order Order to be executed
    */
    function openPosition(IOrderBook.Order memory order, int256 fillAmount, uint256 fulfillPrice, bool isMakerOrder) external onlyOrderBook {
        _openPosition(order, fillAmount, fulfillPrice, isMakerOrder);
    }

    function updatePositions(address trader) override public whenNotPaused {
        require(address(trader) != address(0), 'CH: 0x0 trader Address');
        int256 fundingPayment;
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            (int256 _fundingPayment, int256 cumulativePremiumFraction) = amms[i].updatePosition(trader);
            if (_fundingPayment != 0) {
                fundingPayment += _fundingPayment;
                emit FundingPaid(trader, i, _fundingPayment, cumulativePremiumFraction);
            }
        }
        // -ve fundingPayment means trader should receive funds
        marginAccount.realizePnL(trader, -fundingPayment);
    }

    function settleFunding() override external onlyOrderBook {
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            (int _premiumFraction, int _underlyingPrice, int _cumulativePremiumFraction, uint _nextFundingTime) = amms[i].settleFunding();
            if (_nextFundingTime != 0) {
                emit FundingRateUpdated(
                    i,
                    _premiumFraction,
                    _underlyingPrice.toUint256(),
                    _cumulativePremiumFraction,
                    _nextFundingTime,
                    _blockTimestamp(),
                    block.number
                );
            }
        }
    }

    /* ****************** */
    /*    Liquidations    */
    /* ****************** */

    function liquidate(address trader, uint ammIndex, uint price, int256 toLiquidate)
        override
        external
        onlyOrderBook
    {
        updatePositions(trader);
        _liquidateSingleAmm(trader, ammIndex, price, toLiquidate);
    }

    /* ********************* */
    /* Internal */
    /* ********************* */

    function _liquidateSingleAmm(address trader, uint ammIndex, uint price, int toLiquidate) internal {
        _assertLiquidationRequirement(trader);
        (
            int realizedPnl,
            uint quoteAsset,
            int size,
            uint openNotional
        ) = amms[ammIndex].liquidatePosition(trader, price, toLiquidate);
        emit PositionLiquidated(trader, ammIndex, toLiquidate, quoteAsset, realizedPnl, size, openNotional, _blockTimestamp());

        uint liquidationFee = _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, true /* isLiquidation */, false /* isMakerOrder */);
        marginAccount.transferOutVusd(feeSink, liquidationFee);
    }

    function _chargeFeeAndRealizePnL(
        address trader,
        int realizedPnl,
        uint quoteAsset,
        bool isLiquidation,
        bool isMakerOrder
    )
        internal
        returns (uint fee)
    {
        int256 marginCharge;
        if (isLiquidation) {
            fee = _calculateLiquidationPenalty(quoteAsset);
            marginCharge = realizedPnl - fee.toInt256();
        } else {
            fee = _calculateTradeFee(quoteAsset, isMakerOrder);

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

    function _openPosition(IOrderBook.Order memory order, int256 fillAmount, uint256 fulfillPrice, bool isMakerOrder) internal {
        require(order.baseAssetQuantity != 0 && fillAmount != 0, "CH: baseAssetQuantity == 0");
        updatePositions(order.trader); // adjust funding payments
        uint quoteAsset = abs(fillAmount).toUint256() * fulfillPrice / 1e18;
        (
            int realizedPnl,
            bool isPositionIncreased,
            int size,
            uint openNotional
        ) = amms[order.ammIndex].openPosition(order, fillAmount, fulfillPrice);

        uint _fee = _chargeFeeAndRealizePnL(order.trader, realizedPnl, quoteAsset, false /* isLiquidation */, isMakerOrder);
        marginAccount.transferOutVusd(feeSink, _fee);

        if (isPositionIncreased) {
            assertMarginRequirement(order.trader);
        }
        emit PositionModified(order.trader, order.ammIndex, fillAmount, quoteAsset, realizedPnl, size, openNotional, _blockTimestamp());
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

    function _calculateTradeFee(uint quoteAsset, bool isMakerOrder) internal view returns (uint) {
        if (isMakerOrder) {
            return quoteAsset * makerFee / PRECISION;
        }
        return quoteAsset * takerFee / PRECISION;
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

    function abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
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
        uint nextFundingTime = IAMM(_amm).startFunding();
        // to start funding in vm
        emit FundingRateUpdated(
            l,
            0,
            IAMM(_amm).lastPrice(),
            0,
            nextFundingTime,
            _blockTimestamp(),
            block.number
        );
    }

    function setParams(
        int _maintenanceMargin,
        int _minAllowableMargin,
        uint _takerFee,
        uint _makerFee,
        uint _referralShare,
        uint _tradingFeeDiscount,
        uint _liquidationPenalty
    ) external onlyGovernance {
        require(_maintenanceMargin > 0, "_maintenanceMargin < 0");
        maintenanceMargin = _maintenanceMargin;
        minAllowableMargin = _minAllowableMargin;
        takerFee = _takerFee;
        makerFee = _makerFee;
        referralShare = _referralShare;
        tradingFeeDiscount = _tradingFeeDiscount;
        liquidationPenalty = _liquidationPenalty;
    }
}
