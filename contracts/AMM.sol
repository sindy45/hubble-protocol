// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { VanillaGovernable } from "./legos/Governable.sol";
import { ERC20Detailed, IOracle, IRegistry, IAMM, IClearingHouse } from "./Interfaces.sol";
import { ECDSAUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";

contract AMM is IAMM, VanillaGovernable, EIP712Upgradeable {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 public constant spotPriceTwapInterval = 1 hours;
    uint256 public constant fundingPeriod = 1 hours;
    int256 constant BASE_PRECISION = 1e18;

    address public immutable clearingHouse;

    /* ****************** */
    /*       Storage      */
    /* ****************** */

    // System-wide config

    IOracle public oracle;

    // AMM config

    address override public underlyingAsset;
    string public name;

    uint256 public fundingBufferPeriod;
    uint256 public nextFundingTime;
    int256 public cumulativePremiumFraction;

    uint256 public longOpenInterestNotional;
    uint256 public shortOpenInterestNotional;
    // maximum allowed % difference between mark price and index price
    uint256 public maxOracleSpreadRatio; // scaled 6 decimals
    // maximum allowd % size which can be liquidated in one tx
    uint256 public maxLiquidationRatio; // scaled 6 decimals
    // maximum allowed % difference between mark price and index price before liquidation
    uint256 public maxLiquidationPriceSpread; // scaled 6 decimals

    enum Side { LONG, SHORT }
    struct Position {
        int256 size;
        uint256 openNotional;
        int256 lastPremiumFraction;
        uint liquidationThreshold;
    }
    mapping(address => Position) override public positions;
    mapping(bytes32 => OrderStatus) public ordersStatus;

    struct ReserveSnapshot {
        uint256 lastPrice;
        uint256 timestamp;
        uint256 blockNumber;
    }
    ReserveSnapshot[] public reserveSnapshots;

    /// @notice Min amount of base asset quantity to trade or add liquidity for
    uint256 public minSizeRequirement;

    struct VarGroup1 {
        uint minQuote;
        uint minBase;
        bool isLiquidation;
    }

    // maximum hourly funding rate allowed in %
    int256 public maxFundingRate; // in hourly %,  scaled to 1e6
    // maximum allowed % difference in mark price in a single block
    uint256 public maxPriceSpreadPerBlock; // scaled 6 decimals

    // keccak256("Order(address trader,int256 baseAssetQuantity,uint256 price,uint256 salt)");
    bytes32 public constant ORDER_TYPEHASH = 0x4cab2d4fcf58d07df65ee3d9d1e6e3c407eae39d76ee15b247a025ab52e2c45d;
    uint256[50] private __gap;

    /* ****************** */
    /*       Events       */
    /* ****************** */

    // Generic AMM related events
    event FundingRateUpdated(int256 premiumFraction, uint256 underlyingPrice, int256 cumulativePremiumFraction, uint256 nextFundingTime, uint256 timestamp, uint256 blockNumber);
    event FundingPaid(address indexed trader, int256 takerFundingPayment);
    event Swap(uint256 lastPrice, uint256 openInterestNotional);

    // Trader related events
    event PositionChanged(address indexed trader, int256 size, uint256 openNotional, int256 realizedPnl);

    /**
    * @dev This is only emitted when maker funding related events are updated.
    * These fields are: ignition,dToken,lastPremiumFraction,pos,lastPremiumPerDtoken,posAccumulator
    */

    modifier onlyClearingHouse() {
        require(msg.sender == clearingHouse, "Only clearingHouse");
        _;
    }

    constructor(address _clearingHouse) {
        clearingHouse = _clearingHouse;
    }

    function initialize(
        string memory _name,
        string memory version,
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
        __EIP712_init(name, version);

        // values that most likely wouldn't need to change frequently
        fundingBufferPeriod = 15 minutes;
        maxOracleSpreadRatio = 20 * 1e4; // 20%
        maxLiquidationRatio = 25 * 1e4; // 25%
        maxLiquidationPriceSpread = 1 * 1e4; // 1%
        maxPriceSpreadPerBlock = 1 * 1e4; // 1%
        maxFundingRate = 50; // 0.005%
    }

    /**
    * @dev baseAssetQuantity != 0 has been validated in clearingHouse._openPosition()
    */
    function openPosition(Order memory order, bytes memory signature)
        override
        external
        onlyClearingHouse
        returns (int realizedPnl, uint quoteAsset, bool isPositionIncreased)
    {
        // verify signature and change order status
        _verifyAndUpdateOrder(order, signature, OrderStatus.Filled);

        Position memory position = positions[order.trader];
        bool isNewPosition = position.size == 0 ? true : false;
        Side side = order.baseAssetQuantity > 0 ? Side.LONG : Side.SHORT;
        // @todo replace quoteAssetLimit with price
        uint quoteAssetLimit = abs(order.baseAssetQuantity).toUint256() * order.price / 1e18;
        if (isNewPosition || (position.size > 0 ? Side.LONG : Side.SHORT) == side) {
            // realizedPnl = 0;
            quoteAsset = _increasePosition(order.trader, order.baseAssetQuantity, quoteAssetLimit);
            isPositionIncreased = true;
        } else {
            (realizedPnl, quoteAsset, isPositionIncreased) = _openReversePosition(order.trader, order.baseAssetQuantity, quoteAssetLimit);
        }

        uint totalPosSize = uint(abs(positions[order.trader].size));
        require(totalPosSize == 0 || totalPosSize >= minSizeRequirement, "position_less_than_minSize");
        // update liquidation thereshold
        positions[order.trader].liquidationThreshold = Math.max(
            (totalPosSize * maxLiquidationRatio / 1e6) + 1,
            minSizeRequirement
        );

        _emitPositionChanged(order.trader, realizedPnl);
    }

    function liquidatePosition(address trader)
        override
        external
        onlyClearingHouse
        returns (int realizedPnl, int baseAsset, uint quoteAsset)
    {
        // liquidation price safeguard
        // don't allow trade/liquidations before liquidation
        require(reserveSnapshots[reserveSnapshots.length - 1].blockNumber != block.number, "AMM.liquidation_not_allowed_after_trade");
        int256 oraclePrice = oracle.getUnderlyingPrice(underlyingAsset);
        int256 markPrice = lastPrice().toInt256();
        require(abs(oraclePrice - markPrice) * 1e6 / oraclePrice < maxLiquidationPriceSpread.toInt256(), "AMM.spread_limit_exceeded_between_markPrice_and_indexPrice");

        // don't need an ammState check because there should be no active positions
        Position memory position = positions[trader];
        bool isLongPosition = position.size > 0 ? true : false;
        uint pozSize = uint(abs(position.size));
        uint toLiquidate = Math.min(pozSize, position.liquidationThreshold);

        // this is for backwards compatibility with a rounding-error bug which led to ignore upto .75 of a position when setting the liquidationThreshold
        if (
            toLiquidate != pozSize
            && (toLiquidate * 101 / 100) >= pozSize
        ) {
            // toLiquidate is within 1% of the overall position, then liquidate the entire pos
            toLiquidate = pozSize;
        }

        // liquidate position
        if (isLongPosition) {
            baseAsset = -toLiquidate.toInt256();
            (realizedPnl, quoteAsset) = _reducePosition(trader, baseAsset, 0, true /* isLiquidation */);
        } else {
            baseAsset = toLiquidate.toInt256();
            (realizedPnl, quoteAsset) = _reducePosition(trader, baseAsset, type(uint).max, true /* isLiquidation */);
        }
        _emitPositionChanged(trader, realizedPnl);
    }

    function updatePosition(address trader)
        override
        external
        onlyClearingHouse
        returns(int256 fundingPayment)
    {
        (
            fundingPayment,
            positions[trader].lastPremiumFraction
        ) = getPendingFundingPayment(trader);

        if (fundingPayment != 0) {
            emit FundingPaid(trader, fundingPayment);
        }
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
        remainOpenNotional = uint(openNotional.toInt256() * abs(baseAssetQuantity) / abs(positionSize));
    }

    /**
     * @notice update funding rate
     * @dev only allow to update while reaching `nextFundingTime`
     */
    function settleFunding()
        override
        external
        onlyClearingHouse
    {
        if (
            _blockTimestamp() < nextFundingTime
        ) return;

        // premium = twapMarketPrice - twapIndexPrice
        // timeFraction = fundingPeriod(1 hour) / 1 day
        // premiumFraction = premium * timeFraction
        int256 underlyingPrice = getUnderlyingTwapPrice(spotPriceTwapInterval);
        int256 premium = getTwapPrice(spotPriceTwapInterval) - underlyingPrice;
        int256 premiumFraction = (premium * int256(fundingPeriod)) / 1 days;
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
        uint256 nextFundingTimeOnHourStart = ((nextFundingTime + fundingPeriod) / 1 hours) * 1 hours;

        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        nextFundingTime = nextFundingTimeOnHourStart > minNextValidFundingTime
            ? nextFundingTimeOnHourStart
            : minNextValidFundingTime;

        _emitFundingRateUpdated(premiumFraction, underlyingPrice);
    }

    // View

    function getSnapshotLen() external view returns (uint256) {
        return reserveSnapshots.length;
    }

    function getUnderlyingTwapPrice(uint256 _intervalInSeconds) public view returns (int256) {
        return oracle.getUnderlyingTwapPrice(underlyingAsset, _intervalInSeconds);
    }

    function getTwapPrice(uint256 _intervalInSeconds) public view returns (int256) {
        return _calcTwap(_intervalInSeconds).toInt256();
    }

    function getNotionalPositionAndUnrealizedPnl(address trader)
        override
        public
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl, int256 size, uint256 openNotional)
    {
        Position memory position = positions[trader];
        size = position.size;
        notionalPosition = uint(abs(size) * lastPrice().toInt256() / BASE_PRECISION);
        // @todo redundant size and openNotional
        openNotional = position.openNotional;
        // @todo can convert open notional to int, so that unrealizedPnl = size * lastPrice - openNotional
        if (size > 0) {
            unrealizedPnl = notionalPosition.toInt256() - position.openNotional.toInt256();
        } else if (size < 0) {
            unrealizedPnl = position.openNotional.toInt256() - notionalPosition.toInt256();
        }
    }

    /**
    * @notice returns false if
    * (1-maxSpreadRatio)*indexPrice < markPrice < (1+maxSpreadRatio)*indexPrice
    * else, true
    */
    function isOverSpreadLimit() external view returns(bool) {
        uint oraclePrice = uint(oracle.getUnderlyingPrice(underlyingAsset));
        uint markPrice = lastPrice();
        uint oracleSpreadRatioAbs;
        if (markPrice > oraclePrice) {
            oracleSpreadRatioAbs = markPrice - oraclePrice;
        } else {
            oracleSpreadRatioAbs = oraclePrice - markPrice;
        }
        oracleSpreadRatioAbs = oracleSpreadRatioAbs * 1e6 / oraclePrice;

        if (oracleSpreadRatioAbs >= maxOracleSpreadRatio) {
            return true;
        }
        return false;
    }

    /**
    * @notice returns notionalPosition and unrealizedPnl when isOverSpreadLimit()
    * calculate margin fraction using markPrice and oraclePrice
    * if mode = Maintenance_Margin, return values which have maximum margin fraction
    * if mode = min_allowable_margin, return values which have minimum margin fraction
    */
    function getOracleBasedPnl(address trader, int256 margin, IClearingHouse.Mode mode) override external view returns (uint notionalPosition, int256 unrealizedPnl) {
        int256 size;
        uint openNotional;
        (notionalPosition, unrealizedPnl, size, openNotional) = getNotionalPositionAndUnrealizedPnl(trader);

        if (notionalPosition == 0) {
            return (0, 0);
        }

        int256 marginFraction = (margin + unrealizedPnl) * 1e6 / notionalPosition.toInt256();
        (int oracleBasedNotional, int256 oracleBasedUnrealizedPnl, int256 oracleBasedMF) = _getOracleBasedMarginFraction(
            margin,
            openNotional,
            size
        );

        if (mode == IClearingHouse.Mode.Maintenance_Margin) {
            if (oracleBasedMF > marginFraction) {
                notionalPosition = oracleBasedNotional.toUint256();
                unrealizedPnl = oracleBasedUnrealizedPnl;
            }
        } else if (oracleBasedMF < marginFraction) { // IClearingHouse.Mode.Min_Allowable_Margin
            notionalPosition = oracleBasedNotional.toUint256();
            unrealizedPnl = oracleBasedUnrealizedPnl;
        }
    }

    function _getOracleBasedMarginFraction(int256 margin, uint256 openNotional, int256 size)
        internal
        view
        returns (int oracleBasedNotional, int256 oracleBasedUnrealizedPnl, int256 marginFraction)
    {
        int256 oraclePrice = oracle.getUnderlyingPrice(underlyingAsset);
        oracleBasedNotional = oraclePrice * abs(size) / BASE_PRECISION;
        if (size > 0) {
            oracleBasedUnrealizedPnl = oracleBasedNotional - openNotional.toInt256();
        } else if (size < 0) {
            oracleBasedUnrealizedPnl = openNotional.toInt256() - oracleBasedNotional;
        }

        marginFraction = (margin + oracleBasedUnrealizedPnl) * 1e6 / oracleBasedNotional;
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

    function getNotionalPosition(int256 baseAssetQuantity) override public view returns(uint256 quoteAssetQuantity) {
        return uint(lastPrice().toInt256() * abs(baseAssetQuantity) / BASE_PRECISION);
    }

    function lastPrice() public view returns(uint256) {
        return reserveSnapshots[reserveSnapshots.length - 1].lastPrice;
    }

    function openInterestNotional() public view returns (uint256) {
        return longOpenInterestNotional + shortOpenInterestNotional;
    }

    function getOrderHash(Order memory order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, order)));
    }

    // internal

    /**
    * @dev Go long on an asset
    * @param baseAssetQuantity Exact base asset quantity to go long
    * @param quoteAssetQuantity Maximum amount of quote asset to be used while longing baseAssetQuantity. Lower means longing at a lower price (desirable).
    * @param isLiquidation true if liquidaiton else false
    */
    function _long(int256 baseAssetQuantity, uint quoteAssetQuantity, bool isLiquidation) internal {
        require(baseAssetQuantity > 0, "VAMM._long: baseAssetQuantity is <= 0");

        uint _lastPrice = quoteAssetQuantity * 1e18 / uint(baseAssetQuantity);

        _addReserveSnapshot(_lastPrice);
        // markPrice should not change more than X% in a single block
        uint256 lastBlockTradePrice = _getLastBlockTradePrice();
        require(_lastPrice < lastBlockTradePrice * (1e6 + maxPriceSpreadPerBlock) / 1e6, "AMM.long_single_block_price_slippage");

        // longs not allowed if market price > (1 + maxOracleSpreadRatio)*index price
        uint256 oraclePrice = uint(oracle.getUnderlyingPrice(underlyingAsset));
        oraclePrice = oraclePrice * (1e6 + maxOracleSpreadRatio) / 1e6;
        if (!isLiquidation && _lastPrice > oraclePrice) {
            revert("VAMM._long: longs not allowed");
        }
    }

    /**
    * @dev Go short on an asset
    * @param baseAssetQuantity Exact base asset quantity to short
    * @param quoteAssetQuantity Minimum amount of quote asset to be used while shorting baseAssetQuantity. Higher means shorting at a higher price (desirable).
    * @param isLiquidation true if liquidaiton else false
    */
    function _short(int256 baseAssetQuantity, uint quoteAssetQuantity, bool isLiquidation) internal {
        require(baseAssetQuantity < 0, "VAMM._short: baseAssetQuantity is >= 0");

        uint _lastPrice = quoteAssetQuantity * 1e18 / uint(-baseAssetQuantity);

        _addReserveSnapshot(_lastPrice);
        // markPrice should not change more than X% in a single block
        uint256 lastBlockTradePrice = _getLastBlockTradePrice();
        require(_lastPrice > lastBlockTradePrice * (1e6 - maxPriceSpreadPerBlock) / 1e6, "AMM.short_single_block_price_slippage");

        // shorts not allowed if market price < (1 - maxOracleSpreadRatio)*index price
        uint256 oraclePrice = uint(oracle.getUnderlyingPrice(underlyingAsset));
        oraclePrice = oraclePrice * (1e6 - maxOracleSpreadRatio) / 1e6;
        if (!isLiquidation && _lastPrice < oraclePrice) {
            revert("VAMM._short: shorts not allowed");
        }
    }

    function _getLastBlockTradePrice() internal view returns(uint256 lastBlockTradePrice) {
        uint index = reserveSnapshots.length - 1;
        if (reserveSnapshots[index].blockNumber == block.number && index != 0) {
            lastBlockTradePrice = reserveSnapshots[index - 1].lastPrice;
        } else {
            lastBlockTradePrice = reserveSnapshots[index].lastPrice;
        }
    }

    function _emitPositionChanged(address trader, int256 realizedPnl) internal {
        Position memory position = positions[trader];
        emit PositionChanged(trader, position.size, position.openNotional, realizedPnl);
    }

    /**
    * @dev Get PnL to be realized for the part of the position that is being closed
    *   Check takerPosition != 0 before calling
    */
    function _getPnlWhileReducingPosition(
        int256 takerPosition,
        uint takerOpenNotional,
        int256 makerPosition
    ) internal view returns (int256 pnlToBeRealized) {
        // notional of the combined new position
        uint newNotional = getNotionalPosition(takerPosition + makerPosition);
        uint totalPosition = abs(makerPosition + takerPosition).toUint256();

        if (abs(takerPosition) > abs(makerPosition)) { // taker position side remains same
            uint reducedOpenNotional = takerOpenNotional * abs(makerPosition).toUint256() / abs(takerPosition).toUint256();
            uint makerNotional = newNotional * abs(makerPosition).toUint256() / totalPosition;
            pnlToBeRealized = _getPnlToBeRealized(takerPosition, makerNotional, reducedOpenNotional);
        } else { // taker position side changes
            // @todo handle case when totalPosition = 0
            uint closedPositionNotional = newNotional * abs(takerPosition).toUint256() / totalPosition;
            pnlToBeRealized = _getPnlToBeRealized(takerPosition, closedPositionNotional, takerOpenNotional);
        }
    }

    function _getPnlToBeRealized(int256 takerPosition, uint notionalPosition, uint openNotional) internal pure returns (int256 pnlToBeRealized) {
        if (takerPosition > 0) {
            pnlToBeRealized = notionalPosition.toInt256() - openNotional.toInt256();
        } else {
            pnlToBeRealized = openNotional.toInt256() - notionalPosition.toInt256();
        }
    }

    function _increasePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        internal
        returns(uint quoteAsset)
    {
        if (baseAssetQuantity > 0) { // Long - purchase baseAssetQuantity
            longOpenInterestNotional += baseAssetQuantity.toUint256();
            _long(baseAssetQuantity, quoteAssetLimit, false /* isLiquidation */);
        } else { // Short - sell baseAssetQuantity
            shortOpenInterestNotional += (-baseAssetQuantity).toUint256();
            _short(baseAssetQuantity, quoteAssetLimit, false /* isLiquidation */);
        }
        quoteAsset = quoteAssetLimit;
        positions[trader].size += baseAssetQuantity; // -ve baseAssetQuantity will increase short position
        positions[trader].openNotional += quoteAsset;
    }

    function _openReversePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        internal
        returns (int realizedPnl, uint quoteAsset, bool isPositionIncreased)
    {
        Position memory position = positions[trader];
        if (abs(position.size) >= abs(baseAssetQuantity)) {
            (realizedPnl, quoteAsset) = _reducePosition(trader, baseAssetQuantity, quoteAssetLimit, false /* isLiqudation */);
        } else {
            uint closedRatio = (quoteAssetLimit * abs(position.size).toUint256()) / abs(baseAssetQuantity).toUint256();
            (realizedPnl, quoteAsset) = _reducePosition(trader, -position.size, closedRatio, false /* isLiqudation */);

            // this is required because the user might pass a very less value (slippage-prone) while shorting
            // @todo if statement is not required
            if (quoteAssetLimit >= quoteAsset) {
                quoteAssetLimit -= quoteAsset;
            }
            quoteAsset += _increasePosition(trader, baseAssetQuantity + position.size, quoteAssetLimit);
            isPositionIncreased = true;
        }
    }

    /**
    * @dev validate that baseAssetQuantity <= position.size should be performed before the call to _reducePosition
    */
    function _reducePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit, bool isLiquidation)
        internal
        returns (int realizedPnl, uint256 quoteAsset)
    {
        (, int256 unrealizedPnl,,) = getNotionalPositionAndUnrealizedPnl(trader);

        Position storage position = positions[trader]; // storage because there are updates at the end
        bool isLongPosition = position.size > 0 ? true : false;

        if (isLongPosition) {
            longOpenInterestNotional -= (-baseAssetQuantity).toUint256();
            _short(baseAssetQuantity, quoteAssetLimit, isLiquidation);
        } else {
            shortOpenInterestNotional -= baseAssetQuantity.toUint256();
            _long(baseAssetQuantity, quoteAssetLimit, isLiquidation);
        }
        quoteAsset = quoteAssetLimit;
        (position.openNotional, realizedPnl) = getOpenNotionalWhileReducingPosition(position.size, position.openNotional, unrealizedPnl, baseAssetQuantity);
        position.size += baseAssetQuantity;
    }

    function _addReserveSnapshot(uint256 price)
        internal
    {
        uint256 currentBlock = block.number;
        uint256 blockTimestamp = _blockTimestamp();

        if (reserveSnapshots.length == 0) {
            reserveSnapshots.push(
                ReserveSnapshot(price, blockTimestamp, currentBlock)
            );
            return;
        }

        ReserveSnapshot storage latestSnapshot = reserveSnapshots[reserveSnapshots.length - 1];
        // update values in snapshot if in the same block
        if (currentBlock == latestSnapshot.blockNumber) {
            latestSnapshot.lastPrice = price;
        } else {
            reserveSnapshots.push(
                ReserveSnapshot(price, blockTimestamp, currentBlock)
            );
        }
    }

    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    function _calcTwap(uint256 _intervalInSeconds)
        internal
        view
        returns (uint256)
    {
        uint256 snapshotIndex = reserveSnapshots.length - 1;
        uint256 currentPrice = reserveSnapshots[snapshotIndex].lastPrice;
        if (_intervalInSeconds == 0) {
            return currentPrice;
        }

        uint256 baseTimestamp = _blockTimestamp() - _intervalInSeconds;
        ReserveSnapshot memory currentSnapshot = reserveSnapshots[snapshotIndex];
        // return the latest snapshot price directly
        // if only one snapshot or the timestamp of latest snapshot is earlier than asking for
        if (reserveSnapshots.length == 1 || currentSnapshot.timestamp <= baseTimestamp) {
            return currentPrice;
        }

        uint256 previousTimestamp = currentSnapshot.timestamp;
        uint256 period = _blockTimestamp() - previousTimestamp;
        uint256 weightedPrice = currentPrice * period;
        while (true) {
            // if snapshot history is too short
            if (snapshotIndex == 0) {
                return weightedPrice / period;
            }

            snapshotIndex = snapshotIndex - 1;
            currentSnapshot = reserveSnapshots[snapshotIndex];
            currentPrice = reserveSnapshots[snapshotIndex].lastPrice;

            // check if current round timestamp is earlier than target timestamp
            if (currentSnapshot.timestamp <= baseTimestamp) {
                // weighted time period will be (target timestamp - previous timestamp). For example,
                // now is 1000, _interval is 100, then target timestamp is 900. If timestamp of current round is 970,
                // and timestamp of NEXT round is 880, then the weighted time period will be (970 - 900) = 70,
                // instead of (970 - 880)
                weightedPrice = weightedPrice + (currentPrice * (previousTimestamp - baseTimestamp));
                break;
            }

            uint256 timeFraction = previousTimestamp - currentSnapshot.timestamp;
            weightedPrice = weightedPrice + (currentPrice * timeFraction);
            period = period + timeFraction;
            previousTimestamp = currentSnapshot.timestamp;
        }
        return weightedPrice / _intervalInSeconds;
    }

    function _emitFundingRateUpdated(
        int256 _premiumFraction,
        int256 _underlyingPrice
    ) internal {
        emit FundingRateUpdated(
            _premiumFraction,
            _underlyingPrice.toUint256(),
            cumulativePremiumFraction,
            nextFundingTime,
            _blockTimestamp(),
            block.number
        );
    }

    function _verifyAndUpdateOrder(Order memory order, bytes memory signature, OrderStatus status) internal {
        (, bytes32 orderHash) = _verifySigner(order, signature);
        // AMM_OMBU: Order Must Be Unfilled
        require(ordersStatus[orderHash] == OrderStatus.Unfilled, "AMM_OMBU");
        ordersStatus[orderHash] = status;
    }

    function _verifySigner(Order memory order, bytes memory signature) internal view returns (address, bytes32) {
        bytes32 orderHash = getOrderHash(order);
        address signer = ECDSAUpgradeable.recover(orderHash, signature);

        // AMM_SINT: Signer Is Not Trader
        require(signer == order.trader, "AMM_SINT");

        return (signer, orderHash);
    }

    // Pure

    function abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
    }

    function _max(int x, int y) private pure returns (int) {
        return x >= y ? x : y;
    }

    function _min(int x, int y) private pure returns (int) {
        return x < y ? x : y;
    }

    // Governance

    function changeOracle(address _oracle) public onlyGovernance {
        oracle = IOracle(_oracle);
    }

    function setFundingBufferPeriod(uint _fundingBufferPeriod) external onlyGovernance {
        fundingBufferPeriod = _fundingBufferPeriod;
    }

    function setPriceSpreadParams(uint _maxOracleSpreadRatio, uint _maxPriceSpreadPerBlock) external onlyGovernance {
        maxOracleSpreadRatio = _maxOracleSpreadRatio;
        maxPriceSpreadPerBlock = _maxPriceSpreadPerBlock;
    }

    function setLiquidationParams (uint _maxLiquidationRatio, uint _maxLiquidationPriceSpread) external onlyGovernance {
        maxLiquidationRatio = _maxLiquidationRatio;
        maxLiquidationPriceSpread = _maxLiquidationPriceSpread;
    }

    function setMinSizeRequirement(uint _minSizeRequirement) external onlyGovernance {
        minSizeRequirement = _minSizeRequirement;
    }

    function setMaxFundingRate(int256 _maxFundingRate) external onlyGovernance {
        maxFundingRate = _maxFundingRate;
    }
}
