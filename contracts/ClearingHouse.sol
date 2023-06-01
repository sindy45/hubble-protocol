// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { HubbleBase } from "./legos/HubbleBase.sol";
import { IAMM, IMarginAccount, IClearingHouse, IHubbleReferral, IOrderBook } from "./Interfaces.sol";
import { VUSD } from "./VUSD.sol";
import { IHubbleBibliophile } from "./precompiles/IHubbleBibliophile.sol";

contract ClearingHouse is IClearingHouse, HubbleBase {
    using SafeCast for uint256;
    using SafeCast for int256;

    modifier onlyOrderBook() {
        require(isWhitelistedOrderBook[msg.sender], "Only orderBook");
        _;
    }

    modifier onlyDefaultOrderBook() {
        require(msg.sender == address(defaultOrderBook), "Only orderBook");
        _;
    }

    modifier onlyMySelf() {
        require(msg.sender == address(this), "Only myself");
        _;
    }

    uint256 constant PRECISION = 1e6;
    bytes32 constant public LIQUIDATION_FAILED = keccak256("LIQUIDATION_FAILED");
    int256 constant PRECISION_INT = 1e6;

    int256 override public maintenanceMargin; // SLOT_1 !!! used in precompile !!!
    int256 public minAllowableMargin; // SLOT_2 !!! used in precompile !!!
    int256 override public takerFee; // defining as int for consistency with makerFee
    int256 override public makerFee;
    uint override public liquidationPenalty;
    uint public referralShare;
    uint public tradingFeeDiscount;

    VUSD public vusd;
    address override public feeSink;
    IMarginAccount public marginAccount;
    IOrderBook public defaultOrderBook;
    IAMM[] override public amms;  // SLOT_12 !!! used in precompile !!!
    IHubbleReferral public hubbleReferral;
    uint public lastFundingTime;
    // trader => lastFundingPaid timestamp
    mapping(address => uint) public lastFundingPaid;
    IHubbleBibliophile public bibliophile;
    mapping(address => bool) public isWhitelistedOrderBook;

    uint256[50] private __gap;

    function initialize(
        address _governance,
        address _feeSink,
        address _marginAccount,
        address _defaultOrderBook,
        address _vusd,
        address _hubbleReferral
    ) external
      initializer
    {
        _setGovernace(_governance);

        feeSink = _feeSink;
        marginAccount = IMarginAccount(_marginAccount);
        defaultOrderBook = IOrderBook(_defaultOrderBook);
        vusd = VUSD(_vusd);
        hubbleReferral = IHubbleReferral(_hubbleReferral);
        isWhitelistedOrderBook[_defaultOrderBook] = true;
    }

    /* ****************** */
    /*     Positions      */
    /* ****************** */

    function openComplementaryPositions(
        IOrderBook.Order[2] calldata orders,
        IOrderBook.MatchInfo[2] calldata matchInfo,
        int256 fillAmount,
        uint fulfillPrice
    )   external
        onlyOrderBook
    {

        amms[orders[0].ammIndex].validateTradeAndUpdateTwap(fulfillPrice, false);
        try this.openPosition(orders[0], fillAmount, fulfillPrice, matchInfo[0].mode) {
            // only executed if the above doesn't revert
            try this.openPosition(orders[1], -fillAmount, fulfillPrice, matchInfo[1].mode) {
                // only executed if the above doesn't revert
            } catch Error(string memory reason) {
                // will revert all state changes including those made in this.openPosition(orders[0])
                revert(string(abi.encode(matchInfo[1].orderHash, reason)));
            }
        } catch Error(string memory reason) {
            // surface up the error to the calling contract
            revert(string(abi.encode(matchInfo[0].orderHash, reason)));
        }
    }

   /**
    * @notice Open/Modify/Close Position
    * @param order Order to be executed
    */
    function openPosition(IOrderBook.Order calldata order, int256 fillAmount, uint256 fulfillPrice, IOrderBook.OrderExecutionMode mode) public onlyMySelf {
        _openPosition(order, fillAmount, fulfillPrice, mode);
    }

    function updatePositions(address trader) override public whenNotPaused {
        require(address(trader) != address(0), 'CH: 0x0 trader Address');
        // lastFundingTime will always be >= lastFundingPaid[trader]
        if (lastFundingPaid[trader] != lastFundingTime) {
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

            lastFundingPaid[trader] = lastFundingTime;
        }
    }

    function settleFunding() override external onlyDefaultOrderBook {
        uint numAmms = amms.length;
        uint _nextFundingTime;
        for (uint i; i < numAmms; ++i) {
            int _premiumFraction;
            int _underlyingPrice;
            int _cumulativePremiumFraction;
            (_premiumFraction, _underlyingPrice, _cumulativePremiumFraction, _nextFundingTime) = amms[i].settleFunding();
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
        // nextFundingTime will be same for all amms
        if (_nextFundingTime != 0) {
            lastFundingTime = _blockTimestamp();
        }
    }

    /* ****************** */
    /*    Liquidations    */
    /* ****************** */

    function liquidate(
        IOrderBook.Order calldata order,
        IOrderBook.MatchInfo calldata matchInfo,
        int256 liquidationAmount,
        uint price,
        address trader
    )
        override
        external
        onlyOrderBook
    {
        amms[order.ammIndex].validateTradeAndUpdateTwap(price, true);
        try this.liquidateSingleAmm(trader, order.ammIndex, price, liquidationAmount) {
            // only executed if the above doesn't revert
            try this.openPosition(order, liquidationAmount, price, matchInfo.mode) {
            } catch Error(string memory reason) {
                // will revert all state changes including those made in this.liquidateSingleAmm
                revert(string(abi.encode(matchInfo.orderHash, reason)));
            }
        } catch Error(string memory reason) {
            // surface up the error to the calling contract
            revert(string(abi.encode(LIQUIDATION_FAILED, reason)));
        }
    }

    function liquidateSingleAmm(address trader, uint ammIndex, uint price, int toLiquidate) external onlyMySelf {
        _liquidateSingleAmm(trader, ammIndex, price, toLiquidate);
    }

    /* ********************* */
    /*        Internal       */
    /* ********************* */

    function _liquidateSingleAmm(address trader, uint ammIndex, uint price, int toLiquidate) internal {
        updatePositions(trader); // settle funding payments
        _assertLiquidationRequirement(trader);
        (
            int realizedPnl,
            uint quoteAsset,
            int size,
            uint openNotional
        ) = amms[ammIndex].liquidatePosition(trader, price, toLiquidate);

        (int liquidationFee,) = _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, IOrderBook.OrderExecutionMode.Liquidation);
        marginAccount.transferOutVusd(feeSink, liquidationFee.toUint256()); // will revert if liquidationFee is negative

        emit PositionLiquidated(trader, ammIndex, toLiquidate, price, realizedPnl, size, openNotional, liquidationFee, _blockTimestamp());
    }

    /**
    * @notice calculate trade/liquidatin fee
    * @param realizedPnl realized PnL of the trade, only sent in so that call an extra call to marginAccount.realizePnL can be saved
    * @return toFeeSink fee to be sent to fee sink, always >= 0
    * @return feeCharged total fee including referral bonus and maker fee, can be positive or negative
    * negative feeCharged => fee is payed to the maker
    * referral bonus and fee discount is given when positive fee is charged from either maker or taker
    */
    function _chargeFeeAndRealizePnL(
        address trader,
        int realizedPnl,
        uint quoteAsset,
        IOrderBook.OrderExecutionMode mode
    )
        internal
        returns (int toFeeSink, int feeCharged)
    {
        if (mode == IOrderBook.OrderExecutionMode.Taker) {
            feeCharged = _calculateTakerFee(quoteAsset);
            if (makerFee < 0) {
                // when maker fee is -ve, don't send to fee sink
                // it will be credited to the maker when processing the other side of the trade
                toFeeSink = _calculateMakerFee(quoteAsset); // toFeeSink is now -ve
            }
        } else if (mode == IOrderBook.OrderExecutionMode.SameBlock) {
            // charge taker fee without expecting a corresponding maker component
            feeCharged = _calculateTakerFee(quoteAsset);
        } else if (mode == IOrderBook.OrderExecutionMode.Maker) {
            feeCharged = _calculateMakerFee(quoteAsset); // can be -ve or +ve
        }  else if (mode == IOrderBook.OrderExecutionMode.Liquidation){
            feeCharged = _calculateLiquidationPenalty(quoteAsset);
            if (makerFee < 0) {
                // when maker fee is -ve, don't send to fee sink
                // it will be credited to the maker when processing the other side of the trade
                toFeeSink = _calculateMakerFee(quoteAsset);
            }
        }

        if (feeCharged > 0) {
            toFeeSink += feeCharged;
            if (mode != IOrderBook.OrderExecutionMode.Liquidation) {
                (uint discount, uint referralBonus) = _payReferralBonus(trader, feeCharged.toUint256());
                feeCharged -= discount.toInt256();
                // deduct referral bonus (already credit to referrer) from fee sink share
                toFeeSink = toFeeSink - discount.toInt256() - referralBonus.toInt256();
            }
        }

        marginAccount.realizePnL(trader, realizedPnl - feeCharged);
    }

    /**
     * @param feeCharged fee charged to the trader, caller makes sure that this is positive
    */
    function _payReferralBonus(address trader, uint feeCharged) internal returns(uint discount, uint referralBonus) {
        address referrer = hubbleReferral.getTraderRefereeInfo(trader);
        if (referrer != address(0x0)) {
            referralBonus = feeCharged * referralShare / PRECISION;
            // add margin to the referrer
            // note that this fee will be deducted from the fee sink share in the calling function
            marginAccount.realizePnL(referrer, referralBonus.toInt256());
            emit ReferralBonusAdded(referrer, referralBonus);

            discount = feeCharged * tradingFeeDiscount / PRECISION;
        }
    }

    function _openPosition(IOrderBook.Order memory order, int256 fillAmount, uint256 fulfillPrice, IOrderBook.OrderExecutionMode mode) internal {
        updatePositions(order.trader); // settle funding payments
        uint quoteAsset = abs(fillAmount).toUint256() * fulfillPrice / 1e18;
        (
            int realizedPnl,
            bool isPositionIncreased,
            int size,
            uint openNotional
        ) = amms[order.ammIndex].openPosition(order, fillAmount, fulfillPrice);

        int feeCharged;
        {
            int toFeeSink;
            (toFeeSink, feeCharged) = _chargeFeeAndRealizePnL(order.trader, realizedPnl, quoteAsset, mode);
            if (toFeeSink != 0) {
                marginAccount.transferOutVusd(feeSink, toFeeSink.toUint256());
            }
        }
        {
            // isPositionIncreased is true when the position is increased or reversed
            if (isPositionIncreased) {
                assertMarginRequirement(order.trader);
                require(order.reduceOnly == false, "CH: reduceOnly order can only reduce position");
            }
            emit PositionModified(order.trader, order.ammIndex, fillAmount, fulfillPrice, realizedPnl, size, openNotional, feeCharged, mode, _blockTimestamp());
        }
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
            (_notionalPosition, _unrealizedPnl) = amms[i].getOptimalPnl(trader, margin, mode);
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
        if (address(bibliophile) != address(0x0)) {
            // precompile magic allows us to execute this for a fixed 1k gas
            return bibliophile.getNotionalPositionAndMargin(trader, includeFundingPayments, uint8(mode));
        }
        return getNotionalPositionAndMarginVanilla(trader, includeFundingPayments, mode);
    }

    function getNotionalPositionAndMarginVanilla(address trader, bool includeFundingPayments, Mode mode)
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

    /**
    * @dev This method assumes that pending funding has been settled
    */
    function assertMarginRequirement(address trader) public view {
        require(
            calcMarginFraction(trader, false, Mode.Min_Allowable_Margin) >= minAllowableMargin,
            "CH: Below Minimum Allowable Margin"
        );
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

    function orderBook() external view returns(IOrderBook) {
        return defaultOrderBook;
    }

    /**
     * @notice Get the underlying price of the AMMs
    */
    function getUnderlyingPrice() override public view returns(uint[] memory prices) {
        uint numAmms = amms.length;
        prices = new uint[](numAmms);
        for (uint i; i < numAmms; ++i) {
            prices[i] = amms[i].getUnderlyingPrice();
        }
    }

    /* ****************** */
    /*   Internal View    */
    /* ****************** */

    /**
    * @dev This method assumes that pending funding has been credited
    */
    function _assertLiquidationRequirement(address trader) internal view {
        require(calcMarginFraction(trader, false, Mode.Maintenance_Margin) < maintenanceMargin, "CH: Above Maintenance Margin");
    }

    function _calculateTradeFee(uint quoteAsset, bool isMakerOrder) internal view returns (int) {
        if (isMakerOrder) {
            return _calculateMakerFee(quoteAsset);
        }
        return quoteAsset.toInt256() * takerFee / PRECISION_INT;
    }

    function _calculateTakerFee(uint quoteAsset) internal view returns (int) {
        return quoteAsset.toInt256() * takerFee / PRECISION_INT;
    }

    function _calculateMakerFee(uint quoteAsset) internal view returns (int) {
        return quoteAsset.toInt256() * makerFee / PRECISION_INT;
    }

    function _calculateLiquidationPenalty(uint quoteAsset) internal view returns (int) {
        return (quoteAsset * liquidationPenalty / PRECISION).toInt256();
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
        int _takerFee,
        int _makerFee,
        uint _referralShare,
        uint _tradingFeeDiscount,
        uint _liquidationPenalty
    ) external onlyGovernance {
        require(_maintenanceMargin > 0, "_maintenanceMargin <= 0");
        require(_liquidationPenalty > 0, "_liquidationPenalty < 0");

        maintenanceMargin = _maintenanceMargin;
        minAllowableMargin = _minAllowableMargin;
        takerFee = _takerFee;
        makerFee = _makerFee;
        referralShare = _referralShare;
        tradingFeeDiscount = _tradingFeeDiscount;
        liquidationPenalty = _liquidationPenalty;

        defaultOrderBook.updateParams(_minAllowableMargin.toUint256(), _takerFee.toUint256());
        marginAccount.updateParams(_minAllowableMargin.toUint256());
    }

    function setBibliophile(address _bibliophile) external onlyGovernance {
        bibliophile = IHubbleBibliophile(_bibliophile);
    }
}
