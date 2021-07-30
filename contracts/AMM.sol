pragma solidity 0.8.4;

import "hardhat/console.sol";

contract AMM {

    struct Position {
        int256 size;
        int256 openNotional;
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

    function openPosition(address trader, int256 baseAssetQuantity, int quoteAssetLimit)
        onlyClearingHouse
        external
        returns (int realizedPnl, bool isPositionIncreased)
    {
        Position memory position = positions[trader];
        bool isNewPosition = position.size == 0 ? true : false;
        Side side = baseAssetQuantity > 0 ? Side.LONG : Side.SHORT;
        if (isNewPosition || (position.size > 0 ? Side.LONG : Side.SHORT) == side) {
            _increasePosition(trader, baseAssetQuantity, quoteAssetLimit);
            return (0, true);
        } else {
            console.log('_openReversePosition', uint(baseAssetQuantity), uint(quoteAssetLimit));
            return _openReversePosition(trader, baseAssetQuantity, quoteAssetLimit);
        }
    }

    function _increasePosition(address trader, int256 baseAssetQuantity, int quoteAssetLimit) internal {
        int256 quoteAsset;
        if (baseAssetQuantity > 0) { // Long - purchase baseAssetQuantity
            quoteAsset = int(vamm.exchangeExactOut(0 /* sell quote asset */, 2 /* purchase base asset */, uint(baseAssetQuantity), uint(quoteAssetLimit)));
            // when longing trader wants unit cost of base asset to be as low as possible
            // require(quoteAsset <= quoteAssetLimit, "VAMM._increasePosition.Long: Slippage"); not required because we pass in quoteAssetLimit as the forth param
        } else { // Short - sell baseAssetQuantity
            quoteAsset = int(vamm.exchange(2 /* sell base asset */, 0 /* get quote asset */, uint(-baseAssetQuantity), 0));
            // when shorting trader wants unit cost of base asset to be as high as possible
            require(quoteAsset >= quoteAssetLimit, "VAMM._increasePosition.Short: Slippage");
        }
        positions[trader].size += baseAssetQuantity; // -ve baseAssetQuantity will increase short position
        positions[trader].openNotional += quoteAsset;
    }

    function _openReversePosition(address trader, int256 baseAssetQuantity, int quoteAssetLimit)
        internal
        returns (int realizedPnl, bool isPositionIncreased)
    {
        Position memory position = positions[trader];
        if (abs(position.size) >= abs(baseAssetQuantity)) {
            realizedPnl = _reducePosition(trader, baseAssetQuantity, quoteAssetLimit);
        } else {
            int closedRatio = (quoteAssetLimit * abs(position.size)) / abs(baseAssetQuantity);
            realizedPnl = _reducePosition(trader, -position.size, closedRatio);
            _increasePosition(trader, baseAssetQuantity + position.size, quoteAssetLimit - closedRatio);
            isPositionIncreased = true;
        }
    }

    function _reducePosition(address trader, int256 baseAssetQuantity, int quoteAssetLimit)
        internal
        returns (int realizedPnl)
    {
        Position storage position = positions[trader];

        bool isLongPosition = position.size > 0 ? true : false;
        int256 quoteAsset;
        if (isLongPosition) {
            require(baseAssetQuantity < 0, "VAMM._reducePosition.Long: Incorrect direction");
            quoteAsset = int(vamm.exchange(2 /* sell base asset */, 0 /* get quote asset */, uint(-baseAssetQuantity) /* exact input */, 0));
            require(quoteAsset >= quoteAssetLimit, "VAMM._reducePosition.Long: Slippage");
            realizedPnl = quoteAsset - position.openNotional;
        } else {
            require(baseAssetQuantity > 0, "VAMM._reducePosition.Short: Incorrect direction");
            // we don't yet have vamm.exchangeExactOut
            // quoteAsset = int(vamm.exchangeExactOut(0 /* sell quote asset */, 2 /* purchase shorted asset */, uint(baseAssetQuantity) /* exact output */, 0));
            // require(quoteAsset <= quoteAssetLimit, "VAMM._reducePosition.Short: Slippage");

            baseAssetQuantity = int(vamm.exchange(0 /* sell quote asset */, 2 /* purchase shorted asset */, uint(quoteAssetLimit), 0));
            quoteAsset = quoteAssetLimit;

            realizedPnl = position.openNotional - quoteAsset;
        }
        position.size += baseAssetQuantity;
        position.openNotional -= quoteAsset;
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
     * @return latest cumulative premium fraction in 18 digits
     */
    function getLatestCumulativePremiumFraction() public view returns (int256) {
        uint256 len = cumulativePremiumFractions.length;
        if (len > 0) {
            return cumulativePremiumFractions[len - 1];
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
        external
        view
        returns(int256 notionalPosition, int256 unrealizedPnl)
    {
        Position memory position = positions[trader];
        if (position.size == 0) {
            return (0, 0);
        }
        bool isLongPosition = position.size > 0 ? true : false;
        // The following considers the Spot price. Should we also look at TWAP price?
        if (isLongPosition) {
            notionalPosition = int(vamm.get_dy(2 /* sell base asset */, 0 /* get quote asset */, uint(position.size) /* exact input */));
            unrealizedPnl = notionalPosition - position.openNotional;
        } else {
            notionalPosition = int(vamm.get_dx(0 /* sell quote asset */, 2 /* purchase shorted asset */, uint(-position.size) /* exact output */));
            unrealizedPnl = position.openNotional - notionalPosition;
        }
    }

    function abs(int x) private pure returns (int) {
        return x >= 0 ? x : -x;
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
