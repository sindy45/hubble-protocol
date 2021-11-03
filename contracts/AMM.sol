// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { Governable } from "./Governable.sol";
import { ERC20Detailed, IOracle, IRegistry, IVAMM } from "./Interfaces.sol";

contract AMM is Governable, Pausable {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 public constant spotPriceTwapInterval = 1 hours;
    uint256 public constant fundingPeriod = 1 hours;

    // System-wide config

    IOracle public oracle;
    address public clearingHouse;

    // AMM config

    IVAMM public vamm;
    address public underlyingAsset;
    string public name;

    uint256 public fundingBufferPeriod;
    uint256 public nextFundingTime;
    int256 public fundingRate;
    uint256 public longOpenInterestNotional;
    uint256 public shortOpenInterestNotional;

    struct Position {
        int256 size;
        uint256 openNotional;
        int256 lastUpdatedCumulativePremiumFraction;
    }
    mapping(address => Position) public positions;

    struct ReserveSnapshot {
        uint256 quoteAssetReserve;
        uint256 baseAssetReserve;
        uint256 timestamp;
        uint256 blockNumber;
    }
    ReserveSnapshot[] public reserveSnapshots;

    struct PremiumFraction {
        uint256 blockNumber;
        int256 cumulativePremiumFraction;
    }
    PremiumFraction[] public cumulativePremiumFractions;

    enum Side { LONG, SHORT }

    // Events

    event PositionChanged(address indexed trader, int256 size, uint256 openNotional);
    event FundingRateUpdated(int256 premiumFraction, int256 rate, uint256 underlyingPrice, uint256 timestamp, uint256 blockNumber);
    event FundingPaid(address indexed trader, int256 latestCumulativePremiumFraction, int256 positionSize, int256 fundingPayment);
    event Swap(int256 baseAssetQuantity, uint256 qouteAssetQuantity, uint256 lastPrice, uint256 openInterestNotional);
    event ReserveSnapshotted(uint256 quoteAssetReserve, uint256 baseAssetReserve, uint256 timestamp, uint256 blockNumber);

    modifier onlyClearingHouse() {
        require(msg.sender == clearingHouse, "Only clearingHouse");
        _;
    }

    modifier onlyVamm() {
        require(msg.sender == address(vamm), "Only VAMM");
        _;
    }

    function initialize(
        address _registry,
        address _underlyingAsset,
        string memory _name,
        address _vamm,
        address _governance
    ) external initializer {
        _setGovernace(_governance);

        vamm = IVAMM(_vamm);
        underlyingAsset = _underlyingAsset;
        name = _name;

        syncDeps(_registry);
        _pause(); // not open for trading as yet
    }

    /**
    * @dev baseAssetQuantity != 0 has been validated in clearingHouse._openPosition()
    */
    function openPosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        external
        whenNotPaused
        onlyClearingHouse
        returns (int realizedPnl, uint quoteAsset, bool isPositionIncreased)
    {
        Position memory position = positions[trader];
        bool isNewPosition = position.size == 0 ? true : false;
        Side side = baseAssetQuantity > 0 ? Side.LONG : Side.SHORT;
        if (isNewPosition || (position.size > 0 ? Side.LONG : Side.SHORT) == side) {
            // realizedPnl = 0;
            quoteAsset = _increasePosition(trader, baseAssetQuantity, quoteAssetLimit);
            isPositionIncreased = true;
        } else {
            (realizedPnl, quoteAsset, isPositionIncreased) = _openReversePosition(trader, baseAssetQuantity, quoteAssetLimit);
        }
        _emitPositionChanged(trader);
    }

    function liquidatePosition(address trader)
        external
        whenNotPaused
        onlyClearingHouse
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
        _emitPositionChanged(trader);
    }

    function updatePosition(address trader)
        external
        whenNotPaused
        onlyClearingHouse
        returns(int256 fundingPayment)
    {
        Position storage position = positions[trader];
        int256 latestCumulativePremiumFraction;

        // @todo update position due to liquidity migration / vamm param updates etc.
        (fundingPayment, latestCumulativePremiumFraction) = getFundingPayment(trader);
        position.lastUpdatedCumulativePremiumFraction = latestCumulativePremiumFraction;
        emit FundingPaid(trader, latestCumulativePremiumFraction, position.size, fundingPayment);
    }

    function _increasePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        internal
        returns(uint quoteAsset)
    {
        if (baseAssetQuantity > 0) { // Long - purchase baseAssetQuantity
            longOpenInterestNotional += baseAssetQuantity.toUint256();
            quoteAsset = _long(baseAssetQuantity, quoteAssetLimit);
        } else { // Short - sell baseAssetQuantity
            shortOpenInterestNotional += (-baseAssetQuantity).toUint256();
            quoteAsset = _short(baseAssetQuantity, quoteAssetLimit);
        }
        positions[trader].size += baseAssetQuantity; // -ve baseAssetQuantity will increase short position
        positions[trader].openNotional += quoteAsset;
    }

    function _openReversePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        internal
        returns (int realizedPnl, uint quoteAsset, bool isPositionIncreased)
    {
        Position memory position = positions[trader];
        if (abs(position.size) >= abs(baseAssetQuantity)) {
            (realizedPnl, quoteAsset) = _reducePosition(trader, baseAssetQuantity, quoteAssetLimit);
        } else {
            uint closedRatio = (quoteAssetLimit * abs(position.size).toUint256()) / abs(baseAssetQuantity).toUint256();
            (realizedPnl, quoteAsset) = _reducePosition(trader, -position.size, closedRatio);

            // this is required because the user might pass a very less value (slippage-prone) while shorting
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
    function _reducePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        internal
        returns (int realizedPnl, uint256 quoteAsset)
    {
        (uint256 notionalPosition, int256 unrealizedPnl) = getNotionalPositionAndUnrealizedPnl(trader);

        Position storage position = positions[trader]; // storage because there are updates at the end
        bool isLongPosition = position.size > 0 ? true : false;

        if (isLongPosition) {
            longOpenInterestNotional -= (-baseAssetQuantity).toUint256();
            quoteAsset = _short(baseAssetQuantity, quoteAssetLimit);
        } else {
            shortOpenInterestNotional -= baseAssetQuantity.toUint256();
            quoteAsset = _long(baseAssetQuantity, quoteAssetLimit);
        }
        (position.openNotional, realizedPnl) = getOpenNotionalWhileReducingPosition(position.size, notionalPosition, unrealizedPnl, baseAssetQuantity, quoteAsset);
        position.size += baseAssetQuantity;
    }

    function getOpenNotionalWhileReducingPosition(
        int256 positionSize,
        uint256 notionalPosition,
        int256 unrealizedPnl,
        int256 baseAssetQuantity,
        uint quoteAsset
    )
        public
        pure
        returns(uint256 remainOpenNotional, int realizedPnl)
    {
        // Position memory position = positions[trader];
        bool isLongPosition = positionSize > 0 ? true : false;

        realizedPnl = unrealizedPnl * abs(baseAssetQuantity) / abs(positionSize);
        int256 unrealizedPnlAfter = unrealizedPnl - realizedPnl;

        /**
        * We need to determine the openNotional value of the reduced position now.
        * We know notionalPosition and unrealizedPnlAfter (unrealizedPnl times the ratio of open position)
        * notionalPosition = notionalPosition - quoteAsset (exchangedQuoteAssetAmount)
        * calculate openNotional (it's different depends on long or short side)
        * long: unrealizedPnl = notionalPosition - openNotional => openNotional = notionalPosition - unrealizedPnl
        * short: unrealizedPnl = openNotional - notionalPosition => openNotional = notionalPosition + unrealizedPnl
        */
        if (isLongPosition) {
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
            remainOpenNotional = (notionalPosition.toInt256() - quoteAsset.toInt256() - unrealizedPnlAfter).toUint256();  // will assert that remainOpenNotional >= 0
        } else {
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
            remainOpenNotional = (notionalPosition.toInt256() - quoteAsset.toInt256() + unrealizedPnlAfter).toUint256();  // will assert that remainOpenNotional >= 0
        }
    }

    /**
    * @dev Go long on an asset
    * @param baseAssetQuantity Exact base asset quantity to go long
    * @param max_dx Maximum amount of qoute asset to be used while longing baseAssetQuantity. Lower means longing at a lower price (desirable).
    * @return qouteAssetQuantity quote asset utilised. qouteAssetQuantity / baseAssetQuantity was the average rate.
      qouteAssetQuantity <= max_dx
    */
    function _long(int256 baseAssetQuantity, uint max_dx) internal returns (uint256 qouteAssetQuantity) {
        require(baseAssetQuantity > 0, "VAMM._long: baseAssetQuantity is <= 0");
        if (max_dx != type(uint).max) {
            max_dx *= 1e12;
        }
        qouteAssetQuantity = vamm.exchangeExactOut(
            0, // sell quote asset
            2, // purchase base asset
            baseAssetQuantity.toUint256(), // long exactly. Note that statement asserts that baseAssetQuantity >= 0
            max_dx
        ) / 1e12; // 6 decimals precision
        emit Swap(baseAssetQuantity, qouteAssetQuantity, lastPrice(), openInterestNotional());
    }

    /**
    * @dev Go short on an asset
    * @param baseAssetQuantity Exact base asset quantity to short
    * @param min_dy Minimum amount of qoute asset to be used while shorting baseAssetQuantity. Higher means shorting at a higher price (desirable).
    * @return qouteAssetQuantity quote asset utilised. qouteAssetQuantity / baseAssetQuantity was the average short rate.
      qouteAssetQuantity >= min_dy.
    */
    function _short(int256 baseAssetQuantity, uint min_dy) internal returns (uint256 qouteAssetQuantity) {
        require(baseAssetQuantity < 0, "VAMM._short: baseAssetQuantity is >= 0");
        if (min_dy != type(uint).max) {
            min_dy *= 1e12;
        }
        qouteAssetQuantity = vamm.exchange(
            2, // sell base asset
            0, // get quote asset
            (-baseAssetQuantity).toUint256(), // short exactly. Note that statement asserts that baseAssetQuantity <= 0
            min_dy
        ) / 1e12;
        emit Swap(baseAssetQuantity, qouteAssetQuantity, lastPrice(), openInterestNotional());
    }

    function _emitPositionChanged(address trader) internal {
        Position memory position = positions[trader];
        emit PositionChanged(trader, position.size, position.openNotional);
    }

    function addReserveSnapshot(uint256 _quoteAssetReserve, uint256 _baseAssetReserve)
        onlyVamm
        whenNotPaused
        external
    {
        uint256 currentBlock = block.number;
        uint256 blockTimestamp = _blockTimestamp();
        emit ReserveSnapshotted(_quoteAssetReserve, _baseAssetReserve, blockTimestamp, currentBlock);

        if (reserveSnapshots.length == 0) {
            reserveSnapshots.push(
                ReserveSnapshot(_quoteAssetReserve, _baseAssetReserve, blockTimestamp, currentBlock)
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
                ReserveSnapshot(_quoteAssetReserve, _baseAssetReserve, blockTimestamp, currentBlock)
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
    function settleFunding()
        external
        whenNotPaused
        onlyClearingHouse
        returns (int256, int256)
    {
        require(_blockTimestamp() >= nextFundingTime, "settle funding too early");

        // premium = twapMarketPrice - twapIndexPrice
        // timeFraction = fundingPeriod(1 hour) / 1 day
        // premiumFraction = premium * timeFraction
        int256 underlyingPrice = getUnderlyingTwapPrice(spotPriceTwapInterval);
        int256 premium = getTwapPrice(spotPriceTwapInterval) - underlyingPrice;
        int256 premiumFraction = (premium * int256(fundingPeriod)) / 1 days;

        cumulativePremiumFractions.push(
            PremiumFraction(block.number, premiumFraction + getLatestCumulativePremiumFraction())
        );

        // update funding rate = premiumFraction / twapIndexPrice
        _updateFundingRate(premiumFraction, underlyingPrice);

        // in order to prevent multiple funding settlement during very short time after network congestion
        uint256 minNextValidFundingTime = _blockTimestamp() + fundingBufferPeriod;

        // floor((nextFundingTime + fundingPeriod) / 3600) * 3600
        uint256 nextFundingTimeOnHourStart = ((nextFundingTime + fundingPeriod) / 1 hours) * 1 hours;

        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        nextFundingTime = nextFundingTimeOnHourStart > minNextValidFundingTime
            ? nextFundingTimeOnHourStart
            : minNextValidFundingTime;
        return (
            premiumFraction,
            longOpenInterestNotional.toInt256() - shortOpenInterestNotional.toInt256()
        );
    }

    // View

    /**
     * @notice get latest cumulative premium fraction.
     * @return premiumFraction latest cumulative premium fraction in 18 digits
     */
    function getLatestCumulativePremiumFraction() public view returns (int256 premiumFraction) {
        uint256 len = cumulativePremiumFractions.length;
        if (len > 0) {
            premiumFraction = cumulativePremiumFractions[len - 1].cumulativePremiumFraction;
        }
    }

    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    function getUnderlyingTwapPrice(uint256 _intervalInSeconds) public view returns (int256) {
        return oracle.getUnderlyingTwapPrice(underlyingAsset, _intervalInSeconds);
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

    function _updateFundingRate(
        int256 _premiumFraction,
        int256 _underlyingPrice
    ) internal {
        fundingRate = _premiumFraction * 1e6 / _underlyingPrice;
        emit FundingRateUpdated(_premiumFraction, fundingRate, _underlyingPrice.toUint256(), _blockTimestamp(), block.number);
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
            unrealizedPnl = notionalPosition.toInt256() - position.openNotional.toInt256();
        } else {
            notionalPosition = vamm.get_dx(0 /* sell quote asset */, 2 /* purchase shorted asset */, (-position.size).toUint256() /* exact output */) / 1e12;
            unrealizedPnl = position.openNotional.toInt256() - notionalPosition.toInt256();
        }
    }

    function getFundingPayment(address trader)
        public
        view
        returns(int256 fundingPayment, int256 latestCumulativePremiumFraction)
    {
        latestCumulativePremiumFraction = getLatestCumulativePremiumFraction();
        Position memory position = positions[trader];
        if (position.size == 0) {
            return (0, latestCumulativePremiumFraction);
        }

        if (latestCumulativePremiumFraction == position.lastUpdatedCumulativePremiumFraction) {
            return (0, latestCumulativePremiumFraction);
        }

        // +: trader paid, -: trader received
        fundingPayment = (latestCumulativePremiumFraction - position.lastUpdatedCumulativePremiumFraction)
            * position.size
            / 1e18;
    }

    function getQuote(int256 baseAssetQuantity) external view returns(uint256 qouteAssetQuantity) {
        if (baseAssetQuantity >= 0) {
            return vamm.get_dx(0, 2, baseAssetQuantity.toUint256()) / 1e12 + 1;
        }
        // rounding-down while shorting is not a problem
        // because lower the min_dy, more permissible it is
        return vamm.get_dy(2, 0, (-baseAssetQuantity).toUint256()) / 1e12;
    }

    function lastPrice() public view returns(uint256) {
        return vamm.last_prices(1) / 1e12;
    }

    function openInterestNotional() public view returns (uint256) {
        return longOpenInterestNotional + shortOpenInterestNotional;
    }

    // Pure

    function abs(int x) private pure returns (int) {
        return x >= 0 ? x : -x;
    }

    // Governance

    function togglePause(bool pause_) external onlyGovernance {
        if (pause_ == paused()) return;
        if (pause_) {
            _pause();
        } else {
            _unpause();
            nextFundingTime = ((_blockTimestamp() + fundingPeriod) / 1 hours) * 1 hours;
        }
    }

    function syncDeps(address _registry) public onlyGovernance {
        IRegistry registry = IRegistry(_registry);
        clearingHouse = registry.clearingHouse();
        oracle = IOracle(registry.oracle());
    }

    function setFundingBufferPeriod(uint _fundingBufferPeriod) external onlyGovernance {
        fundingBufferPeriod = _fundingBufferPeriod;
    }
}
