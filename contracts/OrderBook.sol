// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { ECDSAUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { VanillaGovernable } from "./legos/Governable.sol";
import { IClearingHouse, IOrderBook, IAMM } from "./Interfaces.sol";

contract OrderBook is IOrderBook, VanillaGovernable, Pausable, EIP712Upgradeable {
    using SafeCast for uint256;
    using SafeCast for int256;

    // keccak256("Order(uint256 ammIndex,address trader,int256 baseAssetQuantity,uint256 price,uint256 salt)");
    bytes32 public constant ORDER_TYPEHASH = 0xba5bdc08c77846c2444ea7c84fcaf3479e3389b274ebc7ab59358538ca00dbe0;

    IClearingHouse public immutable clearingHouse;

    struct OrderInfo {
        uint blockPlaced;
        int256 filledAmount;
        OrderStatus status;
    }
    mapping(bytes32 => OrderInfo) public orderInfo;
    mapping(address => bool) isValidator;

    // to avoid stack too deep
    struct MatchInfo {
        bytes32 orderHash;
        uint blockPlaced;
        bool isMakerOrder;
    }

    uint256[50] private __gap;

    modifier onlyValidator {
        require(isValidator[msg.sender], "OB.only_validator");
        _;
    }

    constructor(address _clearingHouse) {
        clearingHouse = IClearingHouse(_clearingHouse);
    }

    function initialize(
        string memory _name,
        string memory _version,
        address _governance
    ) external initializer {
        __EIP712_init(_name, _version);
        // this is problematic for re-initialization but as long as we are not changing gov address across runs, it wont be a problem
        _setGovernace(_governance);
    }

    /**
     * Execute matched orders
     * @param orders It is required that orders[0] is a LONG and orders[1] is a SHORT
     * @param signatures To verify authenticity of the order
     * @param fillAmount Amount to be filled for each order. This is to support partial fills.
     *        Should be > 0 (validated in _verifyOrder) and min(unfilled amount in both orders)
    */
    function executeMatchedOrders(
        Order[2] memory orders,
        bytes[2] memory signatures,
        int256 fillAmount
    )   external
        whenNotPaused
        onlyValidator
    {
        // Checks and Effects
        require(orders[0].baseAssetQuantity > 0, "OB_order_0_is_not_long");
        require(orders[1].baseAssetQuantity < 0, "OB_order_1_is_not_short");
        require(orders[0].price /* buy */ >= orders[1].price /* sell */, "OB_orders_do_not_match");
        require(orders[0].ammIndex == orders[1].ammIndex, "OB_orders_for_different_amms");

        MatchInfo memory orderInfo_0 = MatchInfo(bytes32(0), 0, false);
        MatchInfo memory orderInfo_1 = MatchInfo(bytes32(0), 0, false);
        (orderInfo_0.orderHash, orderInfo_0.blockPlaced) = _verifyOrder(orders[0], signatures[0], fillAmount);
        (orderInfo_1.orderHash, orderInfo_1.blockPlaced) = _verifyOrder(orders[1], signatures[1], -fillAmount);
        // @todo min fillAmount and min order.baseAsset check

        // Effects
        _updateOrder(orderInfo_0.orderHash, fillAmount, orders[0].baseAssetQuantity);
        _updateOrder(orderInfo_1.orderHash, -fillAmount, orders[1].baseAssetQuantity);

        // Interactions
        uint fulfillPrice;
        if (orderInfo_0.blockPlaced < orderInfo_1.blockPlaced) {
            orderInfo_0.isMakerOrder = true;
            fulfillPrice = orders[0].price;
        } else if (orderInfo_0.blockPlaced > orderInfo_1.blockPlaced) {
            orderInfo_1.isMakerOrder = true;
            fulfillPrice = orders[1].price;
        } else { // both orders are placed in the same block, not possible to determine what came first in solidity
            orderInfo_0.isMakerOrder = true;
            orderInfo_1.isMakerOrder = true;
            // Bulls (Longs) are our friends. We give them a favorable price in this corner case
            fulfillPrice = orders[1].price;
        }
        clearingHouse.openPosition(orders[0], fillAmount, fulfillPrice, orderInfo_0.isMakerOrder);
        clearingHouse.openPosition(orders[1], -fillAmount, fulfillPrice, orderInfo_1.isMakerOrder);

        emit OrdersMatched(orders, signatures, fillAmount.toUint256(), fulfillPrice, msg.sender);
    }

    function placeOrder(Order memory order, bytes memory signature) external whenNotPaused {
        require(msg.sender == order.trader, "OB_sender_is_not_trader");
        // verifying signature here to avoid too many fake placeOrders
        (, bytes32 orderHash) = verifySigner(order, signature);
        // order should not exist in the orderStatus map already
        require(orderInfo[orderHash].status == OrderStatus.Invalid, "OB_Order_already_exists");
        orderInfo[orderHash] = OrderInfo(block.number, 0, OrderStatus.Placed);
        // @todo assert margin requirements for placing the order
        // @todo min size requirement while placing order

        emit OrderPlaced(order.trader, order, signature);
    }

    function cancelOrder(Order memory order) external {
        require(msg.sender == order.trader, "OB_sender_is_not_trader");
        bytes32 orderHash = getOrderHash(order);
        // order status should be placed
        require(orderInfo[orderHash].status == OrderStatus.Placed, "OB_Order_does_not_exist");
        orderInfo[orderHash].status = OrderStatus.Cancelled;

        emit OrderCancelled(order.trader, order);
    }

    // @todo onlyValidator modifier
    function settleFunding() external whenNotPaused {
        clearingHouse.settleFunding();
    }

    /**
     * @dev assuming one order is in liquidation zone and other is out of it
     * @notice liquidate trader
     * @param trader trader to liquidate
     * @param order order to match when liuidating for a particular amm
     * @param signature signature corresponding to order
     * @param toLiquidate baseAsset amount being traded/liquidated.
     *        toLiquidate!=0 is validated in am.liquidatePosition
    */
    function liquidateAndExecuteOrder(
        address trader,
        Order memory order,
        bytes memory signature,
        uint256 toLiquidate
    )   external
        whenNotPaused
        onlyValidator
    {
        int256 fillAmount = toLiquidate.toInt256();
        if (order.baseAssetQuantity < 0) { // order is short, so short position is being liquidated
            fillAmount *= -1 ;
        }
        clearingHouse.liquidate(trader, order.ammIndex, order.price, fillAmount);

        (bytes32 orderHash,) = _verifyOrder(order, signature, fillAmount);
        _updateOrder(orderHash, fillAmount, order.baseAssetQuantity);

        clearingHouse.openPosition(order, fillAmount, order.price, true /* isMakerOrder */);
        emit LiquidationOrderMatched(trader, order, signature, toLiquidate, msg.sender);
    }

    /* ****************** */
    /*      View      */
    /* ****************** */

    function getLastTradePrices() external view returns(uint[] memory lastTradePrices) {
        uint l = clearingHouse.getAmmsLength();
        lastTradePrices = new uint[](l);
        for (uint i; i < l; i++) {
            IAMM amm = clearingHouse.amms(i);
            lastTradePrices[i] = amm.lastPrice();
        }
    }

    function verifySigner(Order memory order, bytes memory signature) public view returns (address, bytes32) {
        bytes32 orderHash = getOrderHash(order);
        address signer = ECDSAUpgradeable.recover(orderHash, signature);

        // OB_SINT: Signer Is Not Trader
        require(signer == order.trader, "OB_SINT");

        return (signer, orderHash);
    }

    function getOrderHash(Order memory order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, order)));
    }

    /* ****************** */
    /*      Internal      */
    /* ****************** */

    function _verifyOrder(Order memory order, bytes memory signature, int256 fillAmount)
        internal
        view
        returns (bytes32 /* orderHash */, uint /* blockPlaced */)
    {
        (, bytes32 orderHash) = verifySigner(order, signature);
        // order should be in placed status
        require(orderInfo[orderHash].status == OrderStatus.Placed, "OB_invalid_order");
        // order.baseAssetQuantity and fillAmount should have same sign
        require(order.baseAssetQuantity * fillAmount > 0, "OB_fill_and_base_sign_not_match");
        // fillAmount[orderHash] should be strictly increasing or strictly decreasing
        require(orderInfo[orderHash].filledAmount * fillAmount >= 0, "OB_invalid_fillAmount");
        require(abs(orderInfo[orderHash].filledAmount) <= abs(order.baseAssetQuantity), "OB_filled_amount_higher_than_order_base");
        return (orderHash, orderInfo[orderHash].blockPlaced);
    }

    function _updateOrder(bytes32 orderHash, int256 fillAmount, int256 baseAssetQuantity) internal {
        orderInfo[orderHash].filledAmount += fillAmount;
        // update order status if filled
        if (orderInfo[orderHash].filledAmount == baseAssetQuantity) {
            orderInfo[orderHash].status = OrderStatus.Filled;
        }
    }

    /* ****************** */
    /*        Pure        */
    /* ****************** */

    function abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
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

    function setValidatorStatus(address validator, bool status) external onlyGovernance whenNotPaused {
        isValidator[validator] = status;
    }
}
