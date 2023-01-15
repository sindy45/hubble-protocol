// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { IClearingHouse, IOrderBook, IAMM } from "./Interfaces.sol";
import { ECDSAUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";

contract OrderBook is IOrderBook, EIP712Upgradeable {
    using SafeCast for uint256;
    using SafeCast for int256;

    IClearingHouse public immutable clearingHouse;
    // order hash to order amount filled mapping
    mapping(bytes32 => int256) public filledAmount;
    // order hash to order status mapping
    mapping(bytes32 => OrderStatus) public orderStatus;

    // keccak256("Order(uint256 ammIndex,address trader,int256 baseAssetQuantity,uint256 price,uint256 salt)");
    bytes32 public constant ORDER_TYPEHASH = 0xba5bdc08c77846c2444ea7c84fcaf3479e3389b274ebc7ab59358538ca00dbe0;

    uint256[50] private __gap;

    event OrderPlaced(address indexed trader, Order order, bytes signature);
    event OrderCancelled(address indexed trader, Order order);
    event OrdersMatched(Order[2] orders, bytes[2] signatures, uint256 fillAmount, address relayer);

    constructor(address _clearingHouse) {
        clearingHouse = IClearingHouse(_clearingHouse);
    }

    function initialize(
        string memory _name,
        string memory _version
    ) external initializer {
        __EIP712_init(_name, _version);
    }

    // @todo onlyValidator modifier
    function executeMatchedOrders(
        Order[2] memory orders,
        bytes[2] memory signatures,
        uint256 fillAmount
    )  external {
        // @todo validate that orders are matching
        // @todo min fillAmount and min order.baseAsset check?

        // verify signature and open position for order1
        int256 _fillAmount = orders[0].baseAssetQuantity > 0 ? fillAmount.toInt256() : -fillAmount.toInt256();
        _verifyAndUpdateOrder(orders[0], signatures[0], _fillAmount);
        clearingHouse.openPosition(orders[0], _fillAmount);

        // verify signature and open position for order2
        _verifyAndUpdateOrder(orders[1], signatures[1], -_fillAmount);
        clearingHouse.openPosition(orders[1], -_fillAmount);

        emit OrdersMatched(orders, signatures, fillAmount, msg.sender);
    }

    function placeOrder(Order memory order, bytes memory signature) external {
        require(msg.sender == order.trader, "OB_sender_is_not_trader");
        // verifying signature here to avoid too many fake placeOrders
        (, bytes32 orderHash) = verifySigner(order, signature);
        // order should not exist in the orderStatus map already
        require(orderStatus[orderHash] == OrderStatus.UnPlaced, "OB_Order_already_exists");
        orderStatus[orderHash] = OrderStatus.Placed;
        // @todo assert margin requirements for placing the order

        emit OrderPlaced(order.trader, order, signature);
    }

    function cancelOrder(Order memory order) external {
        require(msg.sender == order.trader, "OB_sender_is_not_trader");
        bytes32 orderHash = getOrderHash(order);
        // order status should be placed
        require(orderStatus[orderHash] == OrderStatus.Placed, "OB_Order_does_not_exist");
        orderStatus[orderHash] = OrderStatus.Cancelled;

        emit OrderCancelled(order.trader, order);
    }

    // @todo onlyValidator modifier
    function executeFundingPayment() external {
        clearingHouse.settleFunding();
    }

    /**
    @dev assuming one order is in liquidation zone and other is out of it
    @notice liquidate trader
    @param trader trader to liquidate
    @param order order to match when liuidating for a particular amm
    @param signature signature corresponding to order
    @param toLiquidate baseAsset amount being traded/liquidated
    */
    function liquidateAndExecuteOrder(address trader, Order memory order, bytes memory signature, int toLiquidate) external {
        clearingHouse.liquidate(trader, order.ammIndex, order.price, toLiquidate, msg.sender);
        _verifyAndUpdateOrder(order, signature, toLiquidate);
        clearingHouse.openPosition(order, toLiquidate);
    }

    /* ****************** */
    /*      view      */
    /* ****************** */

    function getLastTradePrices() external view returns(uint[] memory lastTradePrices) {
        uint l = clearingHouse.getAmmsLength();
        lastTradePrices = new uint[](l);
        for (uint i; i < l; i++) {
            IAMM amm = clearingHouse.amms(i);
            lastTradePrices[i] = amm.lastPrice();
        }
    }

    /* ****************** */
    /*      Public      */
    /* ****************** */

    function verifySigner(Order memory order, bytes memory signature) public view returns (address, bytes32) {
        bytes32 orderHash = getOrderHash(order);
        address signer = ECDSAUpgradeable.recover(orderHash, signature);

        // AMM_SINT: Signer Is Not Trader
        require(signer == order.trader, "OB_SINT");

        return (signer, orderHash);
    }

    function getOrderHash(Order memory order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, order)));
    }

    /* ****************** */
    /*      Internal      */
    /* ****************** */

    function _verifyAndUpdateOrder(Order memory order, bytes memory signature, int256 fillAmount) internal returns(bytes32 orderHash) {
        (, orderHash) = verifySigner(order, signature);
        // order should be in placed status
        require(orderStatus[orderHash] == OrderStatus.Placed, "OB_invalid_order");
        // order.baseAssetQuantity and fillAmount should have same sign
        require(order.baseAssetQuantity * fillAmount > 0, "OB_fill_and_base_sign_not_match");
        // fillAmount[orderHash] should be strictly increasing or strictly decreasing
        require(filledAmount[orderHash] * fillAmount >= 0, "OB_invalid_fillAmount");
        filledAmount[orderHash] += fillAmount;
        require(abs(filledAmount[orderHash]) <= abs(order.baseAssetQuantity), "OB_filled_amount_higher_than_order_base");

        // update order status if filled
        if (filledAmount[orderHash] == order.baseAssetQuantity) {
            orderStatus[orderHash] = OrderStatus.Filled;
        }
    }

    /* ****************** */
    /*      Pure      */
    /* ****************** */

    function abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
    }
}
