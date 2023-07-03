// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { Governable } from "../legos/Governable.sol";
import { IClearingHouse } from "../Interfaces.sol";
import { IOrderBookRollupPrecompile } from "../precompiles/OrderBookRollupPrecompile.sol";

interface IOrderBookRollup {
    struct Order {
        uint256 ammIndex;
        address trader;
        int256 baseAssetQuantity;
        uint256 price;
        uint256 salt;
        bool reduceOnly;
        uint256 validUntil;
    }

    struct MatchInfo {
        bytes32 orderHash;
        OrderExecutionMode mode;
    }

    struct OrderInfo {
        int256 filledAmount;
        bool isCancelled;
    }

    enum OrderExecutionMode {
        Taker,
        Maker,
        Liquidation
    }

    event OrdersPlaced(address indexed relayer);
    event OrderCancelled(address indexed trader, bytes32 indexed orderHash, uint timestamp);
    event OrdersMatched(bytes32 indexed orderHash0, bytes32 indexed orderHash1, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);
    event LiquidationOrderMatched(address indexed trader, bytes32 indexed orderHash, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);
    event OrderMatchingError(bytes32 indexed orderHash, string err);
    event LiquidationError(address indexed trader, bytes32 indexed orderHash, string err, uint256 toLiquidate);

    function orderStatus(bytes32 orderHash) external view returns (OrderInfo memory);

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

    /**
     * @notice Execute a long and a short order that match each other.
     * Can only be called by a validator.
     * @param orders orders[0] is the long order and orders[1] is the short order
     * @param fillAmount Amount of base asset to be traded between the two orders. Should be +ve. Scaled by 1e18
    */
    function executeMatchedOrders(Order[2] calldata orders, bytes[2] calldata signatures, int256 fillAmount) external;

    /**
     * @notice Liquidate a trader's position by matching it with a corresponding order
     * @param trader Address of the trader to be liquidated
     * @param order order to execute the liquidation with
     * When liquidating a short position, the liquidation order should be a short order
     * When liquidating a long position, the liquidation order should be a long order
     * @param toLiquidate Amount of base asset to be liquidated. Should be +ve. Scaled by 1e18
    */
    function liquidateAndExecuteOrder(address trader, Order calldata order, bytes calldata signature, uint256 toLiquidate) external;
}

/**
 * @title Send signed orders as transaction payload. Validations only happen at the time of matching.
*/
contract OrderBookRollup is IOrderBookRollup, Governable, Pausable {
    using SafeCast for uint256;
    using SafeCast for int256;

    IClearingHouse public immutable clearingHouse;

    IOrderBookRollupPrecompile public precompile;
    mapping(bytes32 => OrderInfo) internal _orderStatus;

    uint256[50] private __gap;

    constructor(address _clearingHouse) {
        clearingHouse = IClearingHouse(_clearingHouse);
    }

    function initialize(
        address _governance,
        address _precompile
    ) external initializer {
        _setGovernace(_governance);
        precompile = IOrderBookRollupPrecompile(_precompile);
    }

    /**
     * @inheritdoc IOrderBookRollup
    */
    function placeOrders(Order[] calldata /* orders */, bytes[] calldata /* signatures */) external {
        emit OrdersPlaced(msg.sender);
    }

    /**
     * @inheritdoc IOrderBookRollup
    */
    function cancelOrders(Order[] calldata orders) external {
        bytes32[] memory orderHashes = precompile.validateCancelOrders(orders, _msgSender());
        for (uint i; i < orderHashes.length; i++) {
            _orderStatus[orderHashes[i]].isCancelled = true;
        }
    }

    /* ****************** */
    /*    Match Orders    */
    /* ****************** */

    /**
     * @inheritdoc IOrderBookRollup
    */
    function executeMatchedOrders(
        Order[2] calldata orders,
        bytes[2] calldata signatures,
        int256 fillAmount
    )   override
        external
        whenNotPaused
    {
        (uint fillPrice, IClearingHouse.Instruction[2] memory instructions) = precompile.validateOrdersAndDetermineFillPrice(orders, signatures, fillAmount, _msgSender(), address(this));
        try clearingHouse.openComplementaryPositions(instructions, fillAmount, fillPrice) returns (uint256 openInterestNotional) {
            _updateOrder(instructions[0].orderHash, fillAmount);
            _updateOrder(instructions[1].orderHash, -fillAmount);
            emit OrdersMatched(
                instructions[0].orderHash,
                instructions[1].orderHash,
                fillAmount.toUint256(), // asserts fillAmount is +ve
                fillPrice,
                openInterestNotional,
                msg.sender, // relayer
                block.timestamp
            );
        } catch Error(string memory err) { // catches errors emitted from "revert/require"
            try this.parseMatchingError(err) returns(bytes32 orderHash, string memory reason) {
                emit OrderMatchingError(orderHash, reason);
            } catch (bytes memory) {
                // abi.decode failed; we bubble up the original err
                revert(err);
            }
            return;
        }
        /* catch (bytes memory err) {
            we do not any special handling for other generic type errors
            they can revert the entire tx as usual
        } */
    }

    /* ****************** */
    /*    Liquidation     */
    /* ****************** */

    /**
     * @inheritdoc IOrderBookRollup
    */
    function liquidateAndExecuteOrder(
        address trader,
        Order calldata order,
        bytes calldata signature,
        uint256 liquidationAmount
    )   override
        external
        whenNotPaused
    {
        (uint fillPrice, IClearingHouse.Instruction memory instruction) = precompile.validateLiquidationOrderAndDetermineFillPrice(order, signature, liquidationAmount.toInt256(), _msgSender(), address(this));

        int256 fillAmount = liquidationAmount.toInt256();
        if (order.baseAssetQuantity < 0) { // order is short, so short position is being liquidated
            fillAmount *= -1;
        }

        try clearingHouse.liquidate(instruction, fillAmount, fillPrice, trader) returns (uint256 openInterestNotional) {
            _updateOrder(instruction.orderHash, fillAmount);
            emit LiquidationOrderMatched(
                trader,
                instruction.orderHash,
                liquidationAmount,
                order.price,
                openInterestNotional,
                msg.sender, // relayer
                block.timestamp
            );
        } catch Error(string memory err) { // catches errors emitted from "revert/require"
            try this.parseMatchingError(err) returns(bytes32 _orderHash, string memory reason) {
                if (instruction.orderHash == _orderHash) { // err in openPosition for the order
                    emit OrderMatchingError(_orderHash, reason);
                    reason = "OrderMatchingError";
                } // else err in liquidating the trader; but we emit this either ways so that we can track liquidation didnt succeed for whatever reason
                emit LiquidationError(trader, _orderHash, reason, liquidationAmount);
            } catch (bytes memory) {
                // abi.decode failed; we bubble up the original err
                revert(err);
            }
            return;
        }
        /* catch (bytes memory err) {
            we do not any special handling for other generic type errors
            they can revert the entire tx as usual
        } */
    }


    /* ****************** */
    /*        View        */
    /* ****************** */

    function orderStatus(bytes32 orderHash) override external view returns (OrderInfo memory) {
        return _orderStatus[orderHash];
    }

    /* ****************** */
    /*      Internal      */
    /* ****************** */

    function _updateOrder(bytes32 orderHash, int256 fillAmount) internal {
        _orderStatus[orderHash].filledAmount += fillAmount;
    }

    /* ****************** */
    /*        Pure        */
    /* ****************** */

    function abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
    }

    function transcodeOrder(Order calldata order, MatchInfo memory matchInfo) internal pure returns (bytes memory) {
        return abi.encode(order.ammIndex, order.trader, matchInfo.orderHash, matchInfo.mode);
    }

    function parseMatchingError(string memory err) public pure returns(bytes32 orderHash, string memory reason) {
        (orderHash, reason) = abi.decode(bytes(err), (bytes32, string));
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function pause() external onlyGovernance {
        _pause();
    }

    function unpause() external onlyGovernance {
        _unpause();
    }

    function setPrecompile(address _precompile) external onlyGovernance {
        precompile = IOrderBookRollupPrecompile(_precompile);
    }

    /**
     * @dev Backwards compatibility with OrderBook.sol
    */
    function updateParams(uint _minAllowableMargin, uint _takerFee) external {}
    function initializeMinSize(int minSize) external {}
}
