// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { IOracle, IRegistry } from "./Interfaces.sol";
import "hardhat/console.sol";

contract AMM {
    using SafeCast for uint256;
    using SafeCast for int256;

    struct Position {
        int256 size;
        uint256 openNotional;
        int256 lastUpdatedCumulativePremiumFraction;
    }

    struct ReserveSnapshot {
        uint256 quoteAssetReserve;
        uint256 baseAssetReserve;
        uint256 timestamp;
        uint256 blockNumber;
    }

    ReserveSnapshot[] public reserveSnapshots;

    mapping(address => Position) public positions;

    address public underlyingAsset;
    IRegistry public registry;

    address public clearingHouse;
    uint256 public spotPriceTwapInterval;
    uint256 public fundingPeriod;
    uint256 public fundingBufferPeriod;
    uint256 public nextFundingTime;
    int256 public fundingRate;

    int256[] public cumulativePremiumFractions;

    IVAMM public vamm;
    enum Side { LONG, SHORT }

    modifier onlyClearingHouse() {
        require(msg.sender == clearingHouse, "Only clearingHouse");
        _;
    }

    constructor(address _clearingHouse, address _vamm, address _underlyingAsset, address _registry) {
        vamm = IVAMM(_vamm);
        clearingHouse = _clearingHouse;
        fundingPeriod = 1 hours;
        spotPriceTwapInterval = 1 hours;
        underlyingAsset = _underlyingAsset;
        registry = IRegistry(_registry);
    }

    /**
    * @dev baseAssetQuantity != 0 has been validated in clearingHouse._openPosition()
    */
    function openPosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        onlyClearingHouse
        external
        returns (int realizedPnl, uint quoteAsset, bool isPositionIncreased)
    {
        Position memory position = positions[trader];
        bool isNewPosition = position.size == 0 ? true : false;
        Side side = baseAssetQuantity > 0 ? Side.LONG : Side.SHORT;
        if (isNewPosition || (position.size > 0 ? Side.LONG : Side.SHORT) == side) {
            return (0, _increasePosition(trader, baseAssetQuantity, quoteAssetLimit), true);
        }
        return _openReversePosition(trader, baseAssetQuantity, quoteAssetLimit);
    }

    function closePosition(address trader)
        onlyClearingHouse
        external
        returns (int realizedPnl, uint quoteAsset)
    {
        Position memory position = positions[trader];
        bool isLongPosition = position.size > 0 ? true : false;
        // sending market orders can fk the trader. @todo put some safe guards around price of liquidations
        if (isLongPosition) {
            (realizedPnl, quoteAsset) = _reducePosition(trader, -position.size, 0);
        } else {
            (realizedPnl, quoteAsset) = _reducePosition(trader, -position.size, type(uint).max);
        }
    }

    function _increasePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        internal
        returns(uint quoteAsset)
    {
        log('_increasePosition', baseAssetQuantity, quoteAssetLimit);
        if (baseAssetQuantity > 0) { // Long - purchase baseAssetQuantity
            quoteAsset = _long(baseAssetQuantity, quoteAssetLimit);
        } else { // Short - sell baseAssetQuantity
            quoteAsset = _short(baseAssetQuantity, quoteAssetLimit);
        }
        positions[trader].size += baseAssetQuantity; // -ve baseAssetQuantity will increase short position
        positions[trader].openNotional += quoteAsset;
    }

    function _openReversePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        internal
        returns (int realizedPnl, uint quoteAsset, bool isPositionIncreased)
    {
        log('_openReversePosition', baseAssetQuantity, quoteAssetLimit);
        Position memory position = positions[trader];
        if (abs(position.size) >= abs(baseAssetQuantity)) {
            (realizedPnl, quoteAsset) = _reducePosition(trader, baseAssetQuantity, quoteAssetLimit);
        } else {
            uint closedRatio = (quoteAssetLimit * abs(position.size).toUint256()) / abs(baseAssetQuantity).toUint256();
            (realizedPnl, quoteAsset) = _reducePosition(trader, -position.size, closedRatio);
            quoteAsset += _increasePosition(trader, baseAssetQuantity + position.size, quoteAssetLimit - closedRatio);
            isPositionIncreased = true;
        }
    }

    /**
    * @dev validate that baseAssetQuantity <= position.size should be performed before the call to _reducePosition
    */
    function _reducePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        internal
        returns (int realizedPnl, uint256 quoteAsset)
    {
        log('_reducePosition', baseAssetQuantity, quoteAssetLimit);
        Position storage position = positions[trader];

        (uint256 notionalPosition, int256 unrealizedPnl) = getNotionalPositionAndUnrealizedPnl(trader);
        realizedPnl = unrealizedPnl * abs(baseAssetQuantity) / abs(position.size);
        int256 unrealizedPnlAfter = unrealizedPnl - realizedPnl;

        bool isLongPosition = position.size > 0 ? true : false;
        int256 remainOpenNotional;

        /**
        * We need to determine the openNotional value of the reduced position now.
        * We know notionalPosition and unrealizedPnlAfter (unrealizedPnl times the ratio of open position)
        * notionalPosition = notionalPosition - quoteAsset (exchangedQuoteAssetAmount)
        * calculate openNotional (it's different depends on long or short side)
        * long: unrealizedPnl = notionalPosition - openNotional => openNotional = notionalPosition - unrealizedPnl
        * short: unrealizedPnl = openNotional - notionalPosition => openNotional = notionalPosition + unrealizedPnl
        */
        if (isLongPosition) {
            log('_reducePosition:2', baseAssetQuantity, quoteAssetLimit);
            require(baseAssetQuantity < 0, "VAMM._reducePosition.Long: Incorrect direction");
            quoteAsset = _short(baseAssetQuantity, quoteAssetLimit);
            remainOpenNotional = int256(notionalPosition) - int256(quoteAsset) - unrealizedPnlAfter;
            /**
            * Let baseAssetQuantity = Q, position.size = size, by definition of _reducePosition, abs(size) >= abs(Q)
            * quoteAsset = notionalPosition * Q / size
            * unrealizedPnlAfter = unrealizedPnl - realizedPnl = unrealizedPnl - unrealizedPnl * Q / size
            * remainOpenNotional = notionalPosition - notionalPosition * Q / size - unrealizedPnl + unrealizedPnl * Q / size
            * => remainOpenNotional = notionalPosition(size-Q)/size - unrealizedPnl(size-Q)/size
            * => remainOpenNotional = (notionalPosition - unrealizedPnl) * (size-Q)/size
            * Since notionalPosition includes the PnL component, notionalPosition >= unrealizedPnl and size >= Q
            * Hence remainOpenNotional >= 0
            */
        } else {
            require(baseAssetQuantity > 0, "VAMM._reducePosition.Short: Incorrect direction");
            quoteAsset = _long(baseAssetQuantity, quoteAssetLimit);
            remainOpenNotional = int256(notionalPosition) - int256(quoteAsset) + unrealizedPnlAfter;
            /**
            * Let baseAssetQuantity = Q, position.size = size, by definition of _reducePosition, abs(size) >= abs(Q)
            * quoteAsset = notionalPosition * Q / size
            * unrealizedPnlAfter = unrealizedPnl - realizedPnl = unrealizedPnl - unrealizedPnl * Q / size
            * remainOpenNotional = notionalPosition - notionalPosition * Q / size + unrealizedPnl - unrealizedPnl * Q / size
            * => remainOpenNotional = notionalPosition(size-Q)/size + unrealizedPnl(size-Q)/size
            * => remainOpenNotional = (notionalPosition + unrealizedPnl) * (size-Q)/size
            * => In AMM.sol, unrealizedPnl = position.openNotional - notionalPosition
            * => notionalPosition + unrealizedPnl >= 0
            * Hence remainOpenNotional >= 0
            */
        }
        position.size += baseAssetQuantity;
        position.openNotional = remainOpenNotional.toUint256(); // will assert that remainOpenNotional >= 0
    }

    /**
    * @dev Go long on an asset
    * @param baseAssetQuantity Exact base asset quantity to go long
    * @param max_dx Maximum amount of qoute asset to be used while longing baseAssetQuantity. Lower means longing at a lower price (desirable).
    * @return qouteAssetQuantity quote asset utilised. qouteAssetQuantity / baseAssetQuantity was the average rate.
      qouteAssetQuantity <= max_dx
    */
    function _long(int baseAssetQuantity, uint max_dx) internal returns (uint256 qouteAssetQuantity) {
        if (max_dx != type(uint).max) {
            max_dx *= 1e12;
        }
        qouteAssetQuantity = vamm.exchangeExactOut(
            0, // sell quote asset
            2, // purchase base asset
            baseAssetQuantity.toUint256(), // long exactly
            max_dx
        ) / 1e12; // 6 decimals precision
    }

    /**
    * @dev Go short on an asset
    * @param baseAssetQuantity Exact base asset quantity to short
    * @param min_dy Minimum amount of qoute asset to be used while shorting baseAssetQuantity. Higher means shorting at a higher price (desirable).
    * @return qouteAssetQuantity quote asset utilised. qouteAssetQuantity / baseAssetQuantity was the average short rate.
      qouteAssetQuantity >= min_dy.
    */
    function _short(int baseAssetQuantity, uint min_dy) internal returns (uint256 qouteAssetQuantity) {
        if (min_dy != type(uint).max) {
            min_dy *= 1e12;
        }
        qouteAssetQuantity = vamm.exchange(
            2, // sell base asset
            0, // get quote asset
            (-baseAssetQuantity).toUint256(), // short exactly
            min_dy
        ) / 1e12;
    }

    function addReserveSnapshot(uint256 _quoteAssetReserve, uint256 _baseAssetReserve) external {
        require(msg.sender == address(vamm), "Only AMM"); // only vamm can add snapshots

        uint256 currentBlock = block.number;
        if (reserveSnapshots.length == 0) {
            reserveSnapshots.push(
                ReserveSnapshot(_quoteAssetReserve, _baseAssetReserve, _blockTimestamp(), currentBlock)
            );
            return;
        }

        ReserveSnapshot storage latestSnapshot = reserveSnapshots[reserveSnapshots.length - 1];
        // update values in snapshot if in the same block
        if (currentBlock == latestSnapshot.blockNumber) {
            latestSnapshot.quoteAssetReserve = _quoteAssetReserve;
            latestSnapshot.baseAssetReserve = _baseAssetReserve;
        } else {
            reserveSnapshots.push(
                ReserveSnapshot(_quoteAssetReserve, _baseAssetReserve, _blockTimestamp(), currentBlock)
            );
        }
    }

    function getSnapshotLen() external view returns (uint256) {
        return reserveSnapshots.length;
    }

    /**
     * @notice update funding rate
     * @dev only allow to update while reaching `nextFundingTime`
     * @return premium fraction of this period in 18 digits
     */
    function settleFunding() external returns (int256) {
        require(_blockTimestamp() >= nextFundingTime, "settle funding too early");

        // premium = twapMarketPrice - twapIndexPrice
        // timeFraction = fundingPeriod(1 hour) / 1 day
        // premiumFraction = premium * timeFraction
        int256 underlyingPrice = getUnderlyingTwapPrice(spotPriceTwapInterval);
        int256 premium = getTwapPrice(spotPriceTwapInterval) - underlyingPrice;
        int256 premiumFraction = (premium * int256(fundingPeriod)) / 1 days;

        cumulativePremiumFractions.push(
            premiumFraction + getLatestCumulativePremiumFraction()
        );

        // update funding rate = premiumFraction / twapIndexPrice
        updateFundingRate(premiumFraction, underlyingPrice);

        // in order to prevent multiple funding settlement during very short time after network congestion
        uint256 minNextValidFundingTime = _blockTimestamp() + fundingBufferPeriod;

        // floor((nextFundingTime + fundingPeriod) / 3600) * 3600
        uint256 nextFundingTimeOnHourStart = ((nextFundingTime + fundingPeriod) / 1 hours) * 1 hours;

        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        nextFundingTime = nextFundingTimeOnHourStart > minNextValidFundingTime
            ? nextFundingTimeOnHourStart
            : minNextValidFundingTime;
        return premiumFraction;
    }

    /**
     * @notice get latest cumulative premium fraction.
     * @return premiumFraction latest cumulative premium fraction in 18 digits
     */
    function getLatestCumulativePremiumFraction() public view returns (int256 premiumFraction) {
        uint256 len = cumulativePremiumFractions.length;
        if (len > 0) {
            premiumFraction = cumulativePremiumFractions[len - 1];
        }
    }

    function updatePosition(address trader) external onlyClearingHouse returns(int256 fundingPayment) {
        // @todo update position due to liquidity migration etc.
        int256 latestCumulativePremiumFraction = getLatestCumulativePremiumFraction();
        Position storage position = positions[trader];
        fundingPayment = ((latestCumulativePremiumFraction - position.lastUpdatedCumulativePremiumFraction) * position.size) / 1e18;
        position.lastUpdatedCumulativePremiumFraction = latestCumulativePremiumFraction;
    }

    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    function getUnderlyingTwapPrice(uint256 _intervalInSeconds) public view returns (int256) {
        return IOracle(registry.oracle()).getUnderlyingTwapPrice(underlyingAsset, _intervalInSeconds);
        // return int256(vamm.last_prices(1));
    }

    function getTwapPrice(uint256 _intervalInSeconds) public view returns (int256) {
        return int256(_calcTwap(_intervalInSeconds));
    }

    function getSpotPrice() public view returns (int256) {
        return int256(vamm.balances(0) * 1e6 / vamm.balances(2));
    }

    function _calcTwap(uint256 _intervalInSeconds)
        internal
        view
        returns (uint256)
    {
        uint256 snapshotIndex = reserveSnapshots.length - 1;
        uint256 currentPrice = getPriceWithSpecificSnapshot(snapshotIndex);
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
            currentPrice = getPriceWithSpecificSnapshot(snapshotIndex);

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

    function getPriceWithSpecificSnapshot(uint256 _snapshotIndex)
        internal
        view
        returns (uint256)
    {
        ReserveSnapshot memory snapshot = reserveSnapshots[_snapshotIndex];
        return snapshot.quoteAssetReserve * 1e6 / snapshot.baseAssetReserve;
    }

    function updateFundingRate(
        int256 _premiumFraction,
        int256 _underlyingPrice
    ) private {
        fundingRate = _premiumFraction * 1e18 / _underlyingPrice;
        // emit FundingRateUpdated(fundingRate, _underlyingPrice);
    }

    // View

    function getNotionalPositionAndUnrealizedPnl(address trader)
        public
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl)
    {
        Position memory position = positions[trader];
        if (position.size == 0) {
            return (0, 0);
        }
        bool isLongPosition = position.size > 0 ? true : false;
        // The following considers the spot price. Should we also look at TWAP price?
        if (isLongPosition) {
            notionalPosition = vamm.get_dy(2 /* sell base asset */, 0 /* get quote asset */, position.size.toUint256() /* exact input */) / 1e12;
            // console.log("notionalPosition: %s, position.openNotional %s", notionalPosition, position.openNotional);
            unrealizedPnl = notionalPosition.toInt256() - position.openNotional.toInt256();
        } else {
            notionalPosition = vamm.get_dx(0 /* sell quote asset */, 2 /* purchase shorted asset */, (-position.size).toUint256() /* exact output */) / 1e12;
            unrealizedPnl = position.openNotional.toInt256() - notionalPosition.toInt256();
        }
    }

    function getQuote(int256 baseAssetQuantity) external view returns(uint256 qouteAssetQuantity) {
        if (baseAssetQuantity >= 0) {
            return vamm.get_dx(0, 2, baseAssetQuantity.toUint256()) / 1e12;
        }
        return vamm.get_dy(2, 0, (-baseAssetQuantity).toUint256()) / 1e12;
    }

    // Pure

    function abs(int x) private pure returns (int) {
        return x >= 0 ? x : -x;
    }

    function log(string memory name, int256 baseAssetQuantity, uint quoteAssetLimit) internal pure {
        // console.log('function: %s, quoteAssetLimit: %d', name, quoteAssetLimit);
        // console.log('baseAssetQuantity');
        // console.logInt(baseAssetQuantity);
    }
}

interface IVAMM {
    function balances(uint256) external view returns (uint256);

    function get_dy(
        uint256 i,
        uint256 j,
        uint256 dx
    ) external view returns (uint256);

    function get_dx(
        uint256 i,
        uint256 j,
        uint256 dy
    ) external view returns (uint256);

    function exchange(
        uint256 i,
        uint256 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256 dy);

    function exchangeExactOut(
        uint256 i,
        uint256 j,
        uint256 dy,
        uint256 max_dx
    ) external returns (uint256 dx);

    function last_prices(uint256 k) external view returns(uint256);
    function price_oracle(uint256 k) external view returns(uint256);
}
