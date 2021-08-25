pragma solidity 0.8.4;

import "hardhat/console.sol";

contract AMM {

    struct Position {
        int256 size;
        uint256 openNotional;
        int256 lastUpdatedCumulativePremiumFraction;
    }
    mapping(address => Position) public positions;
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

    constructor(address _clearingHouse, address _vamm) {
        vamm = IVAMM(_vamm);
        clearingHouse = _clearingHouse;
        fundingPeriod = 1 hours;
    }

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

    function _increasePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit) internal returns(uint quoteAsset) {
        log('_increasePosition', baseAssetQuantity, quoteAssetLimit);
        if (baseAssetQuantity >= 0) { // Long - purchase baseAssetQuantity
            quoteAsset = _long(uint(baseAssetQuantity), quoteAssetLimit);
        } else { // Short - sell baseAssetQuantity
            quoteAsset = _short(uint(-baseAssetQuantity), quoteAssetLimit);
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
            uint closedRatio = (quoteAssetLimit * abs(position.size)) / abs(baseAssetQuantity);
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
        realizedPnl = unrealizedPnl * int(abs(baseAssetQuantity)) / int(abs(position.size));
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
            quoteAsset = _short(uint(-baseAssetQuantity), quoteAssetLimit);
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
            quoteAsset = _long(uint(baseAssetQuantity), quoteAssetLimit);
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
        // console.logInt(realizedPnl);
        // console.logInt(remainOpenNotional);
        position.size += baseAssetQuantity;
        require(remainOpenNotional >= 0, "vamm._reducePosition: Unexpected state");
        position.openNotional = uint(remainOpenNotional);
    }

    /**
    * @dev Go long on an asset
    * @param baseAssetQuantity Exact base asset quantity to go long
    * @param max_dx Maximum amount of qoute asset to be used while longing baseAssetQuantity. Lower means longing at a lower price (desirable).
    * @return qouteAssetQuantity quote asset utilised. qouteAssetQuantity / baseAssetQuantity was the average rate.
      qouteAssetQuantity <= max_dx
    */
    function _long(uint baseAssetQuantity, uint max_dx) internal returns (uint256 qouteAssetQuantity) {
        if (max_dx != type(uint).max) {
            max_dx *= 1e12;
        }
        qouteAssetQuantity = vamm.exchangeExactOut(0 /* sell quote asset */, 2 /* purchase base asset */, baseAssetQuantity, max_dx);
        qouteAssetQuantity /= 1e12;
    }

    /**
    * @dev Go short on an asset
    * @param baseAssetQuantity Exact base asset quantity to short
    * @param min_dy Minimum amount of qoute asset to be used while shorting baseAssetQuantity. Higher means shorting at a higher price (desirable).
    * @return qouteAssetQuantity quote asset utilised. qouteAssetQuantity / baseAssetQuantity was the average short rate.
      qouteAssetQuantity >= min_dy.
    */
    function _short(uint baseAssetQuantity, uint min_dy) internal returns (uint256 qouteAssetQuantity) {
        if (min_dy != type(uint).max) {
            min_dy *= 1e12;
        }
        qouteAssetQuantity = vamm.exchange(2 /* sell base asset */, 0 /* get quote asset */, baseAssetQuantity, min_dy);
        qouteAssetQuantity /= 1e12;
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
        return int256(vamm.last_prices(1));
    }

    function getTwapPrice(uint256 _intervalInSeconds) public view returns (int256) {
        return int256(vamm.price_oracle(1));
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
        // The following considers the Spot price. Should we also look at TWAP price?
        if (isLongPosition) {
            notionalPosition = vamm.get_dy(2 /* sell base asset */, 0 /* get quote asset */, uint(position.size) /* exact input */) / 1e12;
            // console.log("notionalPosition: %s, position.openNotional %s", notionalPosition, position.openNotional);
            unrealizedPnl = int(notionalPosition) - int(position.openNotional);
        } else {
            notionalPosition = vamm.get_dx(0 /* sell quote asset */, 2 /* purchase shorted asset */, uint(-position.size) /* exact output */) / 1e12;
            unrealizedPnl = int(position.openNotional) - int(notionalPosition);
        }
    }

    function abs(int x) private pure returns (uint) {
        return x >= 0 ? uint(x) : uint(-x);
    }

    function log(string memory name, int256 baseAssetQuantity, uint quoteAssetLimit) internal {
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
