pragma solidity 0.8.4;

contract AMM {

    struct Position {
        int256 size;
        int256 openNotional;
    }
    mapping(address => Position) public positions;
    address public clearingHouse;

    IVAMM public vamm;
    enum Side { LONG, SHORT }

    modifier onlyClearingHouse() {
        require(msg.sender == clearingHouse, "Only clearingHouse");
        _;
    }

    function openPosition(address trader, int256 baseAssetQuantity, int quoteAssetLimit)
        onlyClearingHouse
        external
        returns (int realizedPnl)
    {
        Position memory position = positions[trader];
        bool isNewPosition = position.size == 0 ? true : false;
        Side side = baseAssetQuantity > 0 ? Side.LONG : Side.SHORT;
        if (isNewPosition || (position.size > 0 ? Side.LONG : Side.SHORT) == side) {
            _increasePosition(trader, baseAssetQuantity, quoteAssetLimit);
            return 0;
        } else {
            return _openReversePosition(trader, baseAssetQuantity, quoteAssetLimit);
        }
    }

    function _increasePosition(address trader, int256 baseAssetQuantity, int quoteAssetLimit) internal {
        int256 quoteAsset;
        if (baseAssetQuantity > 0) { // Long - purchase baseAssetQuantity
            quoteAsset = int(vamm.exchange(1 /* sell quote asset */, 0 /* purchase base asset */, uint(baseAssetQuantity), 0));
            // when longing trader wants unit cost of base asset to be as low as possible
            require(quoteAsset <= quoteAssetLimit, "VAMM._increasePosition.Long: Slippage");
        } else { // Short - sell baseAssetQuantity
            quoteAsset = int(vamm.exchange(0, 1, uint(-baseAssetQuantity), 0));
            // when shorting trader wants unit cost of base asset to be as high as possible
            require(quoteAsset >= quoteAssetLimit, "VAMM._increasePosition.Short: Slippage");
        }
        positions[trader].size += baseAssetQuantity; // -ve baseAssetQuantity will increase short position
        positions[trader].openNotional += quoteAsset;
    }

    function _openReversePosition(address trader, int256 baseAssetQuantity, int quoteAssetLimit)
        internal
        returns (int realizedPnl)
    {
        Position memory position = positions[trader];
        if (abs(position.size) > abs(baseAssetQuantity)) {
            realizedPnl = _reducePosition(trader, baseAssetQuantity, quoteAssetLimit);
        } else {
            int closedRatio = (quoteAssetLimit * abs(position.size)) / abs(baseAssetQuantity);
            realizedPnl = _reducePosition(trader, -position.size, closedRatio);
            _increasePosition(trader, baseAssetQuantity + position.size, quoteAssetLimit - closedRatio);
        }
    }

    function _reducePosition(address trader, int256 baseAssetQuantity, int quoteAssetLimit)
        internal
        returns (int realizedPnl)
    {
        Position memory position = positions[trader];

        bool isLongPosition = position.size > 0 ? true : false;
        int256 notionalPosition;
        if (isLongPosition) {
            require(baseAssetQuantity < 0, "VAMM._reducePosition.Long: Incorrect direction");
            notionalPosition = int(vamm.exchange(0 /* sell base asset */, 1 /* get quote asset */, uint(-baseAssetQuantity) /* exact input */, 0));
            require(notionalPosition >= quoteAssetLimit, "VAMM._reducePosition.Long: Slippage");
            realizedPnl = notionalPosition - position.openNotional;
        } else {
            require(baseAssetQuantity > 0, "VAMM._reducePosition.Short: Incorrect direction");
            notionalPosition = int(vamm.exchange(1 /* sell quote asset */, 0 /* purchase shorted asset */, uint(-position.size) /* exact output */, 0));
            require(notionalPosition <= quoteAssetLimit, "VAMM._reducePosition.Short: Slippage");
            realizedPnl = position.openNotional - notionalPosition;
        }
        position.size -= baseAssetQuantity;
        position.openNotional -= notionalPosition;
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
            notionalPosition = int(vamm.get_dy(0 /* sell base asset */, 1 /* get quote asset */, uint(position.size) /* exact input */));
            unrealizedPnl = notionalPosition - position.openNotional;
        } else {
            notionalPosition = int(vamm.get_dx(1 /* sell quote asset */, 0 /* purchase shorted asset */, uint(-position.size) /* exact output */));
            unrealizedPnl = position.openNotional - notionalPosition;
        }
    }

    function abs(int x) private pure returns (int) {
        return x >= 0 ? x : -x;
    }

    // function notionalPosition(address trader) public view returns(uint) {
    //     Position memory position = positions[trader];
    //     if (position.size == 0) {
    //         return 0;
    //     }
    //     if (position.size > 0) {
    //         return vamm.get_dy(0, 1, position.size /* exact input */);
    //     }
    //     return vamm.get_dx(1, 0, -position.size /* exact output */);
    // }

    // function getUnrealizedPnL(address trader) external view returns(int256) {
    //     Position memory position = positions[trader];
    //     if (position.size > 0) {
    //         return notionalPosition(trader) - position.openNotional;
    //     }
    //     return position.openNotional - notionalPosition(trader);
    // }
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
    ) external returns (uint256);
}
