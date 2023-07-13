// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";

import { Governable } from "../legos/Governable.sol";
import { IOrderHandler } from "./IOrderHandler.sol";
import { IJuror } from "../precompiles/Juror.sol";

interface IOrderBookRollup is IOrderHandler {
    struct Order {
        uint8 orderType;
        uint256 ammIndex;
        address trader;
        int256 baseAssetQuantity;
        uint256 price;
        uint256 salt;
        bool reduceOnly;
        uint256 validUntil;
    }

    struct OrderInfo {
        int256 filledAmount;
        bool isCancelled;
    }

    event OrdersPlaced(address indexed relayer);
    event OrderCancelled(address indexed trader, bytes32 indexed orderHash, uint timestamp);

    /**
     * @notice Send signed orders as part of this tx. Even a relayer can use this method to aggregate and send orders for a large number of users
     * @dev This is just a broadcast mechanism. These do not perform any state change. Just emit an event to notify clients that some orders have been broadcasted.
    */
    function placeOrders(Order[] calldata orders, bytes[] calldata signatures) external;

    /**
     * @notice Cancel multiple orders.
     * @dev Even if one order fails to be cancelled for whatever reason, entire tx will revert and all other orders will also fail to be cancelled.
    */
    function cancelOrders(Order[] calldata orders) external;

    function orderStatus(bytes32 orderHash) external view returns (OrderInfo memory);
}

/**
 * @title Send signed orders as transaction payload. Validations only happen at the time of matching.
*/
contract OrderBookRollup is IOrderBookRollup, Governable, Pausable {
    address public immutable defaultOrderBook;

    mapping(bytes32 => OrderInfo) internal _orderStatus;
    IJuror public juror;

    uint256[50] private __gap;

    modifier onlyDefaultOrderBook() {
        require(msg.sender == defaultOrderBook, "only default orderBook");
        _;
    }

    constructor(address _defaultOrderBook) {
        defaultOrderBook = _defaultOrderBook;
    }

    function initialize(
        address _governance,
        address _juror
    ) external initializer {
        _setGovernace(_governance);
        juror = IJuror(_juror);
    }

    /**
     * @inheritdoc IOrderBookRollup
    */
    function placeOrders(Order[] calldata /* orders */, bytes[] calldata /* signatures */) external {
        // no validations makes this super efficient
        // however we might consider adding some validations here. Re-evaluate before launch
        emit OrdersPlaced(msg.sender);
    }

    /**
     * @inheritdoc IOrderBookRollup
    */
    function cancelOrders(Order[] calldata orders) external {
        bytes32[] memory orderHashes = juror.validateCancelRollupOrders(orders, _msgSender());
        for (uint i; i < orderHashes.length; i++) {
            _orderStatus[orderHashes[i]].isCancelled = true;
        }
    }

    function updateOrder(bytes calldata /* encodedOrder */, bytes calldata metadata) external onlyDefaultOrderBook {
        (bytes32 orderHash, int256 fillAmount) = abi.decode(metadata, (bytes32, int256));
        _orderStatus[orderHash].filledAmount += fillAmount;
    }

    /* ****************** */
    /*        View        */
    /* ****************** */

    function orderStatus(bytes32 orderHash) override external view returns (OrderInfo memory) {
        return _orderStatus[orderHash];
    }
}
