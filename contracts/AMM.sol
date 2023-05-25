// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Governable } from "./legos/Governable.sol";
import { ERC20Detailed, IOracle, IRegistry, IAMM, IClearingHouse, IOrderBook } from "./Interfaces.sol";

contract AMM is IAMM, Governable {
    using SafeCast for uint256;
    using SafeCast for int256;

    /* ****************** */
    /*       Structs      */
    /* ****************** */

    struct Position {
        int256 size;
        uint256 openNotional;
        int256 lastPremiumFraction;
        uint liquidationThreshold;
    }

    struct TWAPData {
        uint256 lastPrice;
        uint256 lastTimestamp;
        uint256 accumulator;
        uint256 lastPeriodAccumulator;
    }

    struct VarGroup1 {
        uint minQuote;
        uint minBase;
        bool isLiquidation;
    }

    /* ****************** */
    /*      Constants     */
    /* ****************** */

    int256 constant BASE_PRECISION = 1e18;
    uint256 constant BASE_PRECISION_UINT = 1e18;
    address public immutable clearingHouse;

    /* ****************** */
    /*       Storage      */
    /* ****************** */

    // vars needed in the precompiles should preferably come first and mention the SLOT_# to avoid any potential slot errors
    uint256 public lastTradePrice; // SLOT_1 !!! used in precompile !!!
    mapping(address => Position) override public positions;  // SLOT_2 !!! used in precompile !!!
    int256 public cumulativePremiumFraction; // SLOT_3 !!! used in precompile !!!

    IOracle public oracle;

    address override public underlyingAsset;
    string public name;

    uint256 public fundingBufferPeriod;
    uint256 public nextFundingTime;

    uint256 public longOpenInterestNotional;
    uint256 public shortOpenInterestNotional;
    // maximum allowed % difference between mark price and index price
    uint256 public maxOracleSpreadRatio; // scaled 6 decimals
    // maximum allowd % size which can be liquidated in one tx
    uint256 public maxLiquidationRatio; // scaled 6 decimals
    // maximum allowed % difference between mark price and index price before liquidation
    uint256 public maxLiquidationPriceSpread; // scaled 6 decimals

    uint256 public spotPriceTwapInterval;
    uint256 public fundingPeriod;
    TWAPData public markPriceTwapData;

    enum Side { LONG, SHORT }

    /// @notice Min amount of base asset quantity to trade
    uint256 public minSizeRequirement;
    // maximum hourly funding rate allowed in %
    int256 public maxFundingRate; // in hourly %,  scaled to 1e6

    uint256[50] private __gap;

    /* ****************** */
    /*    Storage Ends    */
    /* ****************** */

    modifier onlyClearingHouse() {
        require(msg.sender == clearingHouse, "Only clearingHouse");
        _;
    }

    constructor(address _clearingHouse) {
        clearingHouse = _clearingHouse;
    }

    function initialize(
        string memory _name,
        address _underlyingAsset,
        address _oracle,
        uint _minSizeRequirement,
        address _governance
    ) external initializer {
        name = _name;
        underlyingAsset = _underlyingAsset;
        oracle = IOracle(_oracle);
        minSizeRequirement = _minSizeRequirement;
        _setGovernace(_governance);

        // values that most likely wouldn't need to change frequently
        fundingBufferPeriod = 15 minutes;
        maxOracleSpreadRatio = 20 * 1e4; // 20%
        maxLiquidationRatio = 25 * 1e4; // 25%
        maxLiquidationPriceSpread = 1 * 1e4; // 1%
        maxFundingRate = 50; // 0.005%

        fundingPeriod = 1 hours;
        spotPriceTwapInterval = 1 hours;
    }

    /**
    * @dev fillAmount != 0 has been validated in orderBook.executeMatchedOrders/liquidateAndExecuteOrder
    */
    function openPosition(IOrderBook.Order memory order, int256 fillAmount, uint256 fulfillPrice)
        override
        external
        onlyClearingHouse
        returns (int realizedPnl, bool isPositionIncreased, int size, uint openNotional)
    {
        Position memory position = positions[order.trader];
        bool isNewPosition = position.size == 0 ? true : false;
        Side side = fillAmount > 0 ? Side.LONG : Side.SHORT;

        if (isNewPosition || (position.size > 0 ? Side.LONG : Side.SHORT) == side) {
            // realizedPnl = 0;
            _increasePosition(order.trader, fillAmount, fulfillPrice);
            isPositionIncreased = true;
        } else {
            (realizedPnl, isPositionIncreased) = _openReversePosition(order.trader, fillAmount, fulfillPrice);
        }

        size = positions[order.trader].size;
        openNotional = positions[order.trader].openNotional;

        uint totalPosSize = uint(abs(size));
        require(totalPosSize == 0 || totalPosSize >= minSizeRequirement, "position_less_than_minSize");
        // update liquidation threshold
        // no need to make liquidationThreshold multiple of minSizeRequirement as its the max limit
        positions[order.trader].liquidationThreshold = Math.max(
            (totalPosSize * maxLiquidationRatio / 1e6) + 1,
            minSizeRequirement
        );
    }

    function liquidatePosition(address trader, uint price, int fillAmount)
        override
        external
        onlyClearingHouse
        returns (int realizedPnl, uint quoteAsset, int size, uint openNotional)
    {
        // liquidation price safeguard
        int256 oraclePrice = oracle.getUnderlyingPrice(underlyingAsset);
        require(abs(oraclePrice - price.toInt256()) * 1e6 / oraclePrice < maxLiquidationPriceSpread.toInt256(), "AMM.spread_limit_exceeded_between_liquidationPrice_and_indexPrice");

        // don't need an ammState check because there should be no active positions
        Position memory position = positions[trader];
        bool isLongPosition = position.size > 0 ? true : false;
        uint pozSize = uint(abs(position.size));
        uint toLiquidate = Math.min(pozSize, position.liquidationThreshold);

        require(abs(fillAmount).toUint256() <= toLiquidate, "AMM_liquidating_too_much_at_once");

        // liquidate position
        // if fillAmount is lower, liquidate till fillAmount
        if (isLongPosition) {
            require(fillAmount > 0, "AMM_matching_trade_should_be_opposite");
            quoteAsset = fillAmount.toUint256() * price / 1e18;
            realizedPnl = _reducePosition(trader, -fillAmount, price, true /* isLiquidation */);
        } else {
            require(fillAmount < 0, "AMM_matching_trade_should_be_opposite");
            quoteAsset = (-fillAmount).toUint256() * price / 1e18;
            realizedPnl = _reducePosition(trader, -fillAmount, price, true /* isLiquidation */);
        }

        size = positions[trader].size;
        openNotional = positions[trader].openNotional;
    }

    function updatePosition(address trader)
        override
        external
        onlyClearingHouse
        returns(int256 fundingPayment, int256 latestCumulativePremiumFraction)
    {
        (
            fundingPayment,
            latestCumulativePremiumFraction
        ) = getPendingFundingPayment(trader);

        positions[trader].lastPremiumFraction = latestCumulativePremiumFraction;
    }

    function getOpenNotionalWhileReducingPosition(
        int256 positionSize,
        uint256 openNotional,
        int256 unrealizedPnl,
        int256 baseAssetQuantity
    )
        override
        public
        pure
        returns(uint256 remainOpenNotional, int realizedPnl)
    {
        require(abs(positionSize) >= abs(baseAssetQuantity), "AMM.ONLY_REDUCE_POS");

        realizedPnl = unrealizedPnl * abs(baseAssetQuantity) / abs(positionSize);
        remainOpenNotional = openNotional - uint(openNotional.toInt256() * abs(baseAssetQuantity) / abs(positionSize));
    }

    /**
     * @notice update funding rate
     * @dev only allow to update while reaching `nextFundingTime`
     */
    function settleFunding()
        override
        external
        onlyClearingHouse
        returns (
            int256 premiumFraction,
            int256 underlyingPrice,
            int256 /* cumulativePremiumFraction */, // required for emitting events
            uint256 /* nextFundingTime */
        )
    {
        if (
            _blockTimestamp() < nextFundingTime
        ) return (0, 0, 0, 0);

        // premium = twapMarketPrice - twapIndexPrice
        // timeFraction = fundingPeriod(1 hour) / 1 day
        // premiumFraction = premium * timeFraction
        // @todo calculate oracle twap for exact funding period
        underlyingPrice = getUnderlyingTwapPrice(spotPriceTwapInterval);
        int256 premium = getMarkPriceTwap() - underlyingPrice;
        premiumFraction = (premium * int256(fundingPeriod)) / 1 days;
        // funding rate cap
        // if premiumFraction > 0, premiumFraction = min(premiumFraction, maxFundingRate * indexTwap)
        // if premiumFraction < 0, premiumFraction = max(premiumFraction, -maxFundingRate * indexTwap)
        if (maxFundingRate != 0) {
            int256 premiumFractionLimit = maxFundingRate * underlyingPrice / 1e6;
            if (premiumFraction > 0) {
                premiumFraction = _min(premiumFraction, premiumFractionLimit);
            } else {
                premiumFraction = _max(premiumFraction, -premiumFractionLimit);
            }
        }

        cumulativePremiumFraction += premiumFraction;

        // Updates for next funding event
        // in order to prevent multiple funding settlement during very short time after network congestion
        uint256 minNextValidFundingTime = _blockTimestamp() + fundingBufferPeriod;

        // floor((nextFundingTime + fundingPeriod) / 3600) * 3600
        uint256 nextFundingTimeOnHourStart = ((nextFundingTime + fundingPeriod) / fundingPeriod) * fundingPeriod;

        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        nextFundingTime = nextFundingTimeOnHourStart > minNextValidFundingTime
            ? nextFundingTimeOnHourStart
            : minNextValidFundingTime;

        return (premiumFraction, underlyingPrice, cumulativePremiumFraction, nextFundingTime);
    }

    function startFunding() external onlyClearingHouse returns (uint256) {
        nextFundingTime = ((_blockTimestamp() + fundingPeriod) / fundingPeriod) * fundingPeriod;
        return nextFundingTime;
    }

    /* ****************** */
    /*       View         */
    /* ****************** */

    function getUnderlyingTwapPrice(uint256 _intervalInSeconds) public view returns (int256) {
        return oracle.getUnderlyingTwapPrice(underlyingAsset, _intervalInSeconds);
    }

    function getMarkPriceTwap() public view returns (int256) {
        return _calcTwap().toInt256();
    }

    /**
     * @notice Get notional postion and unrealized PnL at the last trade price
    */
    function getNotionalPositionAndUnrealizedPnl(address trader)
        override
        external
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl)
    {
        (notionalPosition, unrealizedPnl,) = getPositionMetadata(lastPrice(), positions[trader].openNotional, positions[trader].size, 0 /* margin (unused) */);
    }

    /**
    * @notice returns max/min(oracle_mf, last_price_mf) depending on mode
    * if mode = Maintenance_Margin, return values which have maximum margin fraction i.e we make the best effort to save user from the liquidation
    * if mode = Min_Allowable_Margin, return values which have minimum margin fraction. We use this to determine whether user can take any more leverage
    */
    function getOptimalPnl(address trader, int256 margin, IClearingHouse.Mode mode) override external view returns (uint notionalPosition, int256 unrealizedPnl) {
        Position memory position = positions[trader];
        if (position.size == 0) {
            return (0,0);
        }

        // based on last price
        int256 lastPriceBasedMF;
        (notionalPosition, unrealizedPnl, lastPriceBasedMF) = getPositionMetadata(
            lastPrice(),
            position.openNotional,
            position.size,
            margin
        );

        // based on oracle price
        (uint oracleBasedNotional, int256 oracleBasedUnrealizedPnl, int256 oracleBasedMF) = getPositionMetadata(
            oracle.getUnderlyingPrice(underlyingAsset).toUint256(),
            position.openNotional,
            position.size,
            margin
        );

        // while evaluating margin for liquidation, we give the best deal to the user
        if ((mode == IClearingHouse.Mode.Maintenance_Margin && oracleBasedMF > lastPriceBasedMF)
        // when evaluating margin for leverage, we give the worst deal to the user
            || (mode == IClearingHouse.Mode.Min_Allowable_Margin && oracleBasedMF < lastPriceBasedMF)) {
            return (oracleBasedNotional, oracleBasedUnrealizedPnl);
        }
    }

    function getPositionMetadata(uint256 price, uint256 openNotional, int256 size, int256 margin)
        public
        pure
        returns (uint256 notionalPos, int256 uPnl, int256 marginFraction)
    {
        notionalPos = price * abs(size).toUint256() / BASE_PRECISION_UINT;
        if (notionalPos == 0) {
            return (0, 0, 0);
        }
        if (size > 0) {
            uPnl = notionalPos.toInt256() - openNotional.toInt256();
        } else if (size < 0) {
            uPnl = openNotional.toInt256() - notionalPos.toInt256();
        }
        marginFraction = (margin + uPnl) * 1e6 / notionalPos.toInt256();
    }

    function getPendingFundingPayment(address trader)
        override
        public
        view
        returns(
            int256 takerFundingPayment,
            int256 latestCumulativePremiumFraction
        )
    {
        Position memory taker = positions[trader];

        // cache state variables locally for cheaper access and return values
        latestCumulativePremiumFraction = cumulativePremiumFraction;

        // Taker
        takerFundingPayment = (latestCumulativePremiumFraction - taker.lastPremiumFraction)
            * taker.size
            / BASE_PRECISION;
    }

    function lastPrice() public view returns(uint256) {
        // return oracle price at the start of amm
        if (markPriceTwapData.lastTimestamp == 0) {
            return uint(oracle.getUnderlyingPrice(underlyingAsset));
        }
        return markPriceTwapData.lastPrice;
    }

    function getUnderlyingPrice() public view returns(uint256) {
        return uint(oracle.getUnderlyingPrice(underlyingAsset));
    }

    function openInterestNotional() override public view returns (uint256) {
        return longOpenInterestNotional + shortOpenInterestNotional;
    }

    /* ****************** */
    /*       Internal     */
    /* ****************** */

    /**
    * @dev Go long on an asset
    * @param baseAssetQuantity Exact base asset quantity to go long
    * @param price price at which trade to be executed
    * @param isLiquidation true if liquidaiton else false
    */
    function _long(int256 baseAssetQuantity, uint price, bool isLiquidation) internal {
        require(baseAssetQuantity > 0, "AMM._long: baseAssetQuantity is <= 0");
        _updateTWAP(price);

        // longs not allowed if market price > (1 + maxOracleSpreadRatio)*index price
        uint256 oraclePrice = uint(oracle.getUnderlyingPrice(underlyingAsset));
        oraclePrice = oraclePrice * (1e6 + maxOracleSpreadRatio) / 1e6;
        if (!isLiquidation && price > oraclePrice) {
            revert("AMM_price_increase_not_allowed");
        }
    }

    /**
    * @dev Go short on an asset
    * @param baseAssetQuantity Exact base asset quantity to short
    * @param price price at which trade to be executed
    * @param isLiquidation true if liquidaiton else false
    */
    function _short(int256 baseAssetQuantity, uint price, bool isLiquidation) internal {
        require(baseAssetQuantity < 0, "AMM._short: baseAssetQuantity is >= 0");
        _updateTWAP(price);

        // if maxOracleSpreadRatio >= 1e6 it means that 100% variation is allowed which means shorts at $0 will also pass.
        // so we don't need to check for that case
        if (maxOracleSpreadRatio < 1e6) {
            uint256 oraclePrice = uint(oracle.getUnderlyingPrice(underlyingAsset));
            oraclePrice = oraclePrice * (1e6 - maxOracleSpreadRatio) / 1e6;
            if (!isLiquidation && price < oraclePrice) {
                revert("AMM_price_decrease_not_allowed");
            }
        }
    }

    function _increasePosition(address trader, int256 baseAssetQuantity, uint price)
        internal
    {
        if (baseAssetQuantity > 0) { // Long - purchase baseAssetQuantity
            longOpenInterestNotional += baseAssetQuantity.toUint256();
            _long(baseAssetQuantity, price, false /* isLiquidation */);
        } else { // Short - sell baseAssetQuantity
            shortOpenInterestNotional += (-baseAssetQuantity).toUint256();
            _short(baseAssetQuantity, price, false /* isLiquidation */);
        }
        positions[trader].size += baseAssetQuantity; // -ve baseAssetQuantity will increase short position
        positions[trader].openNotional += abs(baseAssetQuantity).toUint256() * price / 1e18;
    }

    function _openReversePosition(address trader, int256 baseAssetQuantity, uint price)
        internal
        returns (int realizedPnl, bool isPositionIncreased)
    {
        Position memory position = positions[trader];
        if (abs(position.size) >= abs(baseAssetQuantity)) {
            (realizedPnl) = _reducePosition(trader, baseAssetQuantity, price, false /* isLiqudation */);
        } else {
            (realizedPnl) = _reducePosition(trader, -position.size, price, false /* isLiqudation */);
            _increasePosition(trader, baseAssetQuantity + position.size, price);
            isPositionIncreased = true;
        }
    }

    /**
    * @dev validate that baseAssetQuantity <= position.size should be performed before the call to _reducePosition
    */
    function _reducePosition(address trader, int256 baseAssetQuantity, uint price, bool isLiquidation)
        internal
        returns (int realizedPnl)
    {
        Position storage position = positions[trader]; // storage because there are updates at the end
        (,int256 unrealizedPnl,) = getPositionMetadata(price, positions[trader].openNotional, positions[trader].size, 0 /* margin (unused) */);

        bool isLongPosition = position.size > 0 ? true : false;

        if (isLongPosition) {
            longOpenInterestNotional -= (-baseAssetQuantity).toUint256();
            _short(baseAssetQuantity, price, isLiquidation);
        } else {
            shortOpenInterestNotional -= baseAssetQuantity.toUint256();
            _long(baseAssetQuantity, price, isLiquidation);
        }
        (position.openNotional, realizedPnl) = getOpenNotionalWhileReducingPosition(position.size, position.openNotional, unrealizedPnl, baseAssetQuantity);
        position.size += baseAssetQuantity;
    }

    function _updateTWAP(uint256 price) internal {
        lastTradePrice = price;
        uint256 currentTimestamp = _blockTimestamp();
        uint256 currentPeriodStart = (currentTimestamp / spotPriceTwapInterval) * spotPriceTwapInterval;
        uint256 lastPeriodStart = currentPeriodStart - spotPriceTwapInterval;
        uint256 deltaTime;

        // If its the first trade in the current period, reset the accumulator, and set the lastPeriod accumulator
        if (markPriceTwapData.lastTimestamp < currentPeriodStart) {
            /**
            * check if there was a trade in the last period
            * though this is not required as we return lastPrice in _calcTwap if there is no trade in last hour
            * keeping it to have correct accumulator values
            */
            if (markPriceTwapData.lastTimestamp > lastPeriodStart) {
                deltaTime = currentPeriodStart - markPriceTwapData.lastTimestamp;
                markPriceTwapData.lastPeriodAccumulator = markPriceTwapData.accumulator + markPriceTwapData.lastPrice * deltaTime;
            } else {
                markPriceTwapData.lastPeriodAccumulator = markPriceTwapData.lastPrice * spotPriceTwapInterval;
            }
            markPriceTwapData.accumulator = (currentTimestamp - currentPeriodStart) * markPriceTwapData.lastPrice;
        } else {
            // Update the accumulator
            deltaTime = currentTimestamp - markPriceTwapData.lastTimestamp;
            markPriceTwapData.accumulator += markPriceTwapData.lastPrice * deltaTime;
        }

        // Update the last price and timestamp
        markPriceTwapData.lastPrice = price;
        markPriceTwapData.lastTimestamp = currentTimestamp;
    }

    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    /**
    * @notice Calculates the TWAP price from the last hour start to the current block timestamp
    */
    function _calcTwap() internal view returns (uint256 twap) {
        uint256 currentPeriodStart = (_blockTimestamp() / spotPriceTwapInterval) * spotPriceTwapInterval;
        uint256 lastPeriodStart = currentPeriodStart - spotPriceTwapInterval;

        // If there is no trade at all, return oracle price twap
        if (markPriceTwapData.lastTimestamp == 0) {
            // @todo calculate oracle twap for exact funding period
            return getUnderlyingTwapPrice(spotPriceTwapInterval).toUint256();
        }

        // If there is no trade in the last period, return the last trade price
        if (markPriceTwapData.lastTimestamp <= lastPeriodStart) {
            return markPriceTwapData.lastPrice;
        }

        /**
        * check if there is any trade after currentPeriodStart
        * since this function will not be called before the nextFundingTime,
        * we can use the lastPeriodAccumulator to calculate the twap if there is a trade after currentPeriodStart
        */
        if (markPriceTwapData.lastTimestamp >= currentPeriodStart) {
            // use the lastPeriodAccumulator to calculate the twap
            twap = markPriceTwapData.lastPeriodAccumulator / spotPriceTwapInterval;
        } else {
            // use the accumulator to calculate the twap
            uint256 currentAccumulator = markPriceTwapData.accumulator + (currentPeriodStart - markPriceTwapData.lastTimestamp) * markPriceTwapData.lastPrice;
            twap = currentAccumulator / spotPriceTwapInterval;
        }
    }

    /* ****************** */
    /*       Pure         */
    /* ****************** */

    function abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
    }

    function _max(int x, int y) private pure returns (int) {
        return x >= y ? x : y;
    }

    function _min(int x, int y) private pure returns (int) {
        return x < y ? x : y;
    }

    /* ****************** */
    /*       Governance   */
    /* ****************** */

    function changeOracle(address _oracle) public onlyGovernance {
        oracle = IOracle(_oracle);
    }

    function setPriceSpreadParams(uint _maxOracleSpreadRatio, uint /* dummy for backwards compatibility */) external onlyGovernance {
        maxOracleSpreadRatio = _maxOracleSpreadRatio;
    }

    function setLiquidationParams(uint _maxLiquidationRatio, uint _maxLiquidationPriceSpread) external onlyGovernance {
        maxLiquidationRatio = _maxLiquidationRatio;
        maxLiquidationPriceSpread = _maxLiquidationPriceSpread;
    }

    function setMinSizeRequirement(uint _minSizeRequirement) external onlyGovernance {
        minSizeRequirement = _minSizeRequirement;
    }

    function setFundingParams(
        uint _fundingPeriod,
        uint _fundingBufferPeriod,
        int256 _maxFundingRate,
        uint _spotPriceTwapInterval
    ) external onlyGovernance {
        fundingPeriod = _fundingPeriod;
        fundingBufferPeriod = _fundingBufferPeriod;
        maxFundingRate = _maxFundingRate;
        spotPriceTwapInterval = _spotPriceTwapInterval;
    }
}
