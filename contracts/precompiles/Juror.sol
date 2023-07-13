// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";

import { IClearingHouse, IAMM } from "../Interfaces.sol";
import { IImmediateOrCancelOrders } from "../orderbooks/ImmediateOrCancelOrders.sol";
import { ILimitOrderBook } from "../orderbooks/LimitOrderBook.sol";
import { IOrderBook } from "../orderbooks/OrderBook.sol";
import { IOrderBookRollup } from "../orderbooks/OrderBookRollup.sol";
import { IOrderHandler } from "../orderbooks/IOrderHandler.sol";
import { VanillaGovernable } from "../legos/Governable.sol";

interface IJuror {
    function validateOrdersAndDetermineFillPrice(
        bytes[2] calldata data,
        int256 fillAmount
    )   external
        view
        returns(
            IClearingHouse.Instruction[2] memory instructions,
            uint8[2] memory orderTypes,
            bytes[2] memory encodedOrders,
            uint256 fillPrice
        );

    function validateLiquidationOrderAndDetermineFillPrice(bytes calldata data, uint256 liquidationAmount)
        external
        view
        returns(
            IClearingHouse.Instruction memory instruction,
            uint8 orderType,
            bytes memory encodedOrder,
            uint256 fillPrice,
            int256 fillAmount
        );

    // IOC Orders
    function validatePlaceIOCOrders(IImmediateOrCancelOrders.Order[] memory orders, address sender) external view returns(bytes32[] memory orderHashes);

    // Rollup Orders
    function validateCancelRollupOrders(IOrderBookRollup.Order[] calldata orders, address sender) external view returns(bytes32[] memory orderHashes);
}

contract Juror is VanillaGovernable {
    using SafeCast for uint256;

    struct Metadata {
        uint256 ammIndex;
        address trader;
        int256 baseAssetQuantity;
        uint256 price;
        uint256 blockPlaced;
        bytes32 orderHash;
    }

    enum Side { Long, Short, Liquidation }

    string constant NOT_IS_MULTIPLE = "not multiple";

    IClearingHouse public immutable clearingHouse;
    IOrderBook public immutable orderBook;

    IImmediateOrCancelOrders public iocOrderBook;
    IOrderBookRollup public orderBookRollup;

    constructor(address _clearingHouse, address _defaultOrderBook, address _governance) {
        clearingHouse = IClearingHouse(_clearingHouse);
        orderBook = IOrderBook(_defaultOrderBook);
        _setGovernace(_governance);
    }

    function validateOrdersAndDetermineFillPrice(
        bytes[2] calldata data,
        int256 fillAmount
    )   external
        view
        returns(
            IClearingHouse.Instruction[2] memory instructions,
            uint8[2] memory orderTypes,
            bytes[2] memory encodedOrders,
            uint256 fillPrice
        )
    {
        require(fillAmount > 0, "expecting positive fillAmount");
        (orderTypes[0], encodedOrders[0]) = abi.decode(data[0], (uint8, bytes));
        Metadata memory m0 = validateOrder(orderTypes[0], encodedOrders[0], Side.Long, fillAmount);
        instructions[0] = IClearingHouse.Instruction({
            ammIndex: m0.ammIndex,
            trader: m0.trader,
            orderHash: m0.orderHash,
            mode : IClearingHouse.OrderExecutionMode(0) // will be ovewritten
        });

        (orderTypes[1], encodedOrders[1]) = abi.decode(data[1], (uint8, bytes));
        Metadata memory m1 = validateOrder(orderTypes[1], encodedOrders[1], Side.Short, -fillAmount);
        instructions[1] = IClearingHouse.Instruction({
            ammIndex: m1.ammIndex,
            trader: m1.trader,
            orderHash: m1.orderHash,
            mode: IClearingHouse.OrderExecutionMode(0) // will be ovewritten
        });

        require(m0.ammIndex == m1.ammIndex, "OB_orders_for_different_amms");
        require(m0.price /* buy */ >= m1.price /* sell */, "OB_orders_do_not_match");
        require(isMultiple(fillAmount, IAMM(clearingHouse.amms(m0.ammIndex)).minSizeRequirement().toInt256()), NOT_IS_MULTIPLE);
        (fillPrice, instructions[0].mode, instructions[1].mode) = _determineFillPrice(m0, m1);
    }

    function validateLiquidationOrderAndDetermineFillPrice(bytes calldata data, uint256 liquidationAmount)
        external
        view
        returns(
            IClearingHouse.Instruction memory instruction,
            uint8 orderType,
            bytes memory encodedOrder,
            uint256 fillPrice,
            int256 fillAmount
        )
    {
        require(liquidationAmount > 0, "expecting positive fillAmount");
        (orderType, encodedOrder) = abi.decode(data, (uint8, bytes));
        fillAmount = liquidationAmount.toInt256();
        Metadata memory m0 = validateOrder(orderType, encodedOrder, Side.Liquidation, fillAmount);
        if (m0.baseAssetQuantity < 0) { // order is short, so short position is being liquidated
            fillAmount *= -1;
        }
        require(isMultiple(fillAmount, IAMM(clearingHouse.amms(m0.ammIndex)).minSizeRequirement().toInt256()), NOT_IS_MULTIPLE);
        instruction = IClearingHouse.Instruction({
            ammIndex: m0.ammIndex,
            trader: m0.trader,
            orderHash: m0.orderHash,
            mode: IClearingHouse.OrderExecutionMode.Maker
        });
        fillPrice = m0.price; // in precompile this is more intelligent
        _validateSpread(m0.ammIndex, fillPrice, true);
    }

    function validateOrder(uint8 orderType, bytes memory orderData, Side side, int256 fillAmount) public view returns (Metadata memory metadata) {
        if (orderType == 0) { // Limit Orders
            ILimitOrderBook.Order memory order = abi.decode(orderData, (ILimitOrderBook.Order));
            return validateExecuteLimitOrder(order, side, fillAmount);
        }
        if (orderType == 1) { // IOC Orders
            IImmediateOrCancelOrders.Order memory order = abi.decode(orderData, (IImmediateOrCancelOrders.Order));
            return validateExecuteIOCOrder(order, side, fillAmount);
        }
        // if (orderType == 2) { // Signed Orders (not yet implemented)
        //     (IOrderBookRollup.Order memory order, bytes memory signature) = abi.decode(orderData, (IOrderBookRollup.Order, bytes));
        //     return validateExecuteRollupOrder(order, signature, side, fillAmount);
        // }
        revert ("invalid order type");
    }

    /* ******************** */
    /*   Limit Orders (T0)  */
    /* ******************** */

    function validateExecuteLimitOrder(ILimitOrderBook.Order memory order, Side side, int256 fillAmount) public view returns (Metadata memory metadata) {
        bytes32 orderHash = ILimitOrderBook(orderBook).getOrderHash(order);
        ILimitOrderBook.OrderInfo memory orderInfo = ILimitOrderBook(orderBook).orderStatus(orderHash);
        _validateLimitOrderLike(order, orderInfo.filledAmount, orderInfo.status, side, fillAmount);
        return Metadata({
            ammIndex: order.ammIndex,
            trader: order.trader,
            baseAssetQuantity: order.baseAssetQuantity,
            price: order.price,
            blockPlaced: orderInfo.blockPlaced,
            orderHash: orderHash
        });
    }

    function _validateLimitOrderLike(ILimitOrderBook.Order memory order, int filledAmount, IOrderHandler.OrderStatus status, Side side, int256 fillAmount) internal view {
        require(status == IOrderHandler.OrderStatus.Placed, "invalid order");

        if (side == Side.Liquidation) {
            if (order.baseAssetQuantity > 0) {
                side = Side.Long;
            } else if (order.baseAssetQuantity < 0) {
                side = Side.Short;
                fillAmount *= -1; // following validations need fillAmount to be in the same direction of order
            }
        }

        uint ammIndex = order.ammIndex;
        if (side == Side.Long) {
            require(order.baseAssetQuantity > 0 && fillAmount > 0, "not long");
            require(filledAmount + fillAmount <= order.baseAssetQuantity, "overfill");
            if (order.reduceOnly) {
                int[] memory posSizes = _getPositionSizes(order.trader);
                require(posSizes[ammIndex] + fillAmount <= 0, "not reducing pos"); // net position should be 0 or short
            }
        } else if (side == Side.Short) {
            require(order.baseAssetQuantity < 0 && fillAmount < 0, "not short");
            require(filledAmount + fillAmount >= order.baseAssetQuantity, "overfill");
            if (order.reduceOnly) {
                int[] memory posSizes = _getPositionSizes(order.trader);
                // fillAmount > 0, so no need to check if posSizes[orders[1].ammIndex] > 0
                require(posSizes[ammIndex] + fillAmount >= 0, "not reducing pos"); // net position should be 0 or long
            }
        } else {
            revert("invalid side");
        }
    }

    /* ******************** */
    /*    IOC Orders (T1)   */
    /* ******************** */

    /**
     * @dev Performs basic validation checks. It's possible that order execution might fail even if this function returns successfully.
     * for e.g. insufficient margin, or reduce only order that doesn't reduce position size. These will however be caught during order execution.
    */
    function validatePlaceIOCOrders(IImmediateOrCancelOrders.Order[] memory orders, address sender) external view returns(bytes32[] memory orderHashes) {
        require(orders.length > 0, "empty orders");
        address trader = orders[0].trader; // will revert if orders.length == 0
        require(sender == trader || orderBook.isTradingAuthority(trader, sender), "no trading authority");
        orderHashes = new bytes32[](orders.length);
        for (uint i = 0; i < orders.length; i++) {
            require(orders[i].trader == trader, "OB_trader_mismatch");
            require(orders[i].orderType == 1, "not_ioc_order");
            // order could have expired already by the time it was being mined
            // for instance because say gas fee were higher but user sent a lower gas fee
            require(orders[i].expireAt >= block.timestamp, "ioc expired"); // including the equality case because it's possible that order is filled in the same block
            require(orders[i].expireAt <= block.timestamp + iocOrderBook.expirationCap(), "ioc expiration too far");
            // this check hasn't been written in the corresponding precompile
            if (orders[i].reduceOnly) {
                int[] memory posSizes = _getPositionSizes(trader);
                require(isOppositeSign(posSizes[orders[i].ammIndex], orders[i].baseAssetQuantity), "OB_reduce_only_order_must_reduce_position");
            }
            // orders should be multiple of pre-defined minimum quantity to prevent spam with dust orders
            require(isMultiple(orders[i].baseAssetQuantity, IAMM(clearingHouse.amms(orders[i].ammIndex)).minSizeRequirement().toInt256()), NOT_IS_MULTIPLE);
            orderHashes[i] = getIOCOrderHash(orders[i]);
            // order should not exist in the orderStatus map already
            IImmediateOrCancelOrders.OrderInfo memory orderInfo = iocOrderBook.orderStatus(orderHashes[i]);
            require(orderInfo.status == IOrderHandler.OrderStatus.Invalid, "already exists");
        }
    }

    function getIOCOrderHash(IImmediateOrCancelOrders.Order memory order) public view returns (bytes32) {
        return iocOrderBook.getOrderHash(order);
    }

    function validateExecuteIOCOrder(IImmediateOrCancelOrders.Order memory order, Side side, int256 fillAmount) public view returns (Metadata memory metadata) {
        require(order.orderType == 1, "not ioc order");
        require(order.expireAt >= block.timestamp, "ioc expired");
        bytes32 orderHash = getIOCOrderHash(order);
        IImmediateOrCancelOrders.OrderInfo memory orderInfo = iocOrderBook.orderStatus(orderHash);

        ILimitOrderBook.Order memory _order = ILimitOrderBook.Order({
            ammIndex: order.ammIndex,
            trader: order.trader,
            baseAssetQuantity: order.baseAssetQuantity,
            price: order.price,
            salt: order.salt,
            reduceOnly: order.reduceOnly
        });
        _validateLimitOrderLike(_order, orderInfo.filledAmount, orderInfo.status, side, fillAmount);
        return Metadata({
            ammIndex: order.ammIndex,
            trader: order.trader,
            baseAssetQuantity: order.baseAssetQuantity,
            price: order.price,
            blockPlaced: orderInfo.blockPlaced,
            orderHash: orderHash
        });

    }

    /* ******************* */
    /*  Rollup Orders (T2) */
    /* ******************* */

    /**
     * @notice perform the following checks on the order:
     * 1. not expired
     * 2. either signed by the trader himself or a valid pre-whitelisted trading authority
     * 3. not cancelled
     * 4. Base asset quantity is not < 0 or > 0 depending on the order type
     * 5. order will not be over filled
     * 6. reduceOnly order is not increasing position size (todo)
     * 7. whether both traders have enough margin for this order pair to be executed (todo)
    */
    function validateExecuteRollupOrder(IOrderBookRollup.Order memory order, bytes memory signature, Side side, int256 fillAmount) public view returns (Metadata memory metadata) {
        require(order.orderType == 2, "not rollup order");
        require(block.timestamp <= order.validUntil, "order_expired");

        bytes32 orderHash = getRollupOrderHash(order);
        address signer = verifySigner(orderHash, signature);
        require(signer == order.trader || orderBook.isTradingAuthority(signer, order.trader), "not_trading_authority");

        IOrderBookRollup.OrderInfo memory orderInfo = orderBookRollup.orderStatus(orderHash);
        require(orderInfo.isCancelled == false, "order_cancelled");
        if (side == Side.Long) {
            require(fillAmount > 0, "invalid_fill_amount");
            require(order.baseAssetQuantity > 0, "invalid_base_asset_quantity");
            require(orderInfo.filledAmount + fillAmount <= order.baseAssetQuantity, "order_overfilled");
        } else if (side == Side.Short) {
            require(fillAmount < 0, "invalid_fill_amount");
            require(order.baseAssetQuantity < 0, "invalid_base_asset_quantity");
            require(orderInfo.filledAmount + fillAmount >= order.baseAssetQuantity, "order_overfilled"); // all 3 quantities are -ve
        }

        // @todo check 6 and 7

        return Metadata({
            ammIndex: order.ammIndex,
            trader: order.trader,
            baseAssetQuantity: order.baseAssetQuantity,
            price: order.price,
            blockPlaced: 0, // unused for rollup orders
            orderHash: orderHash
        });
    }

    /**
     * @notice verifies whether `sender` is a valid trading authority for trader for whom the order is being cancelled
    */
    function validateCancelRollupOrders(IOrderBookRollup.Order[] calldata orders, address sender) external view returns(bytes32[] memory orderHashes) {
        orderHashes = new bytes32[](orders.length);
        for (uint i; i < orderHashes.length; i++) {
            require(sender == orders[i].trader || orderBook.isTradingAuthority(sender, orders[i].trader), "not_trading_authority");
            orderHashes[i] = getRollupOrderHash(orders[i]);
        }
    }

    /**
     * @dev todo
    */
    function getRollupOrderHash(IOrderBookRollup.Order memory order) public view returns (bytes32) {
        // return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, order)));
    }

    /* ****************** */
    /*      Common        */
    /* ****************** */

    /**
     * Following checks are performed:
     * 1. orders are for the same market
     * 2. orders have a price overlap
    */
    function _determineFillPrice(Metadata memory m0, Metadata memory m1)
        internal
        view
        returns (uint256 fillPrice, IClearingHouse.OrderExecutionMode mode0, IClearingHouse.OrderExecutionMode mode1)
    {
        uint ammIndex = m0.ammIndex;
        if (m0.blockPlaced < m1.blockPlaced) {
            mode0 = IClearingHouse.OrderExecutionMode.Maker;
            fillPrice = m0.price;
        } else if (m0.blockPlaced > m1.blockPlaced) {
            mode1 = IClearingHouse.OrderExecutionMode.Maker;
            fillPrice = m1.price;
        } else { // both orders are placed in the same block, not possible to determine what came first in solidity
            // executing both orders as taker order
            mode0 = IClearingHouse.OrderExecutionMode.SameBlock;
            mode1 = IClearingHouse.OrderExecutionMode.SameBlock;
            // Bulls (Longs) are our friends. We give them a favorable price in this corner case
            fillPrice = m1.price;
        }
        _validateSpread(ammIndex, fillPrice, false);
    }

    /**
     * @dev Check whether a given price is within a pre-defined % deviation from the index price of the market.
     * This is to prevent malicious actors from manipulating the price too much
     * @param ammIndex Market index
     * @param price chosen fill price
     * @param isLiquidation whether we should assert for a liquidation match or regular order match, because liquidation has a tigher spread requirement
    */
    function _validateSpread(uint ammIndex, uint256 price, bool isLiquidation) internal view {
        IAMM amm = IAMM(clearingHouse.amms(ammIndex));
        uint spreadLimit = isLiquidation ? amm.maxLiquidationPriceSpread() : amm.maxOracleSpreadRatio();
        uint256 oraclePrice = amm.getUnderlyingPrice();

        uint bound = oraclePrice * (1e6 + spreadLimit) / 1e6;
        require(price <= bound, "AMM.price_GT_bound");
        // if spreadLimit >= 1e6 it means that 100% variation is allowed which means shorts at $0 will also pass.
        // so we don't need to check for that case
        if (spreadLimit < 1e6) {
            bound = oraclePrice * (1e6 - spreadLimit) / 1e6;
            require(price >= bound, "AMM.price_LT_bound");
        }
    }

    function _getPositionSizes(address trader) internal view returns(int[] memory posSizes) {
        uint numAmms = clearingHouse.getAmmsLength();
        posSizes = new int[](numAmms);
        for (uint i; i < numAmms; ++i) {
            IAMM amm = IAMM(clearingHouse.amms(i));
            (posSizes[i],,,) = amm.positions(trader);
        }
    }

    /* ****************** */
    /*        Pure        */
    /* ****************** */

    function verifySigner(bytes32 orderHash, bytes memory signature) public pure returns (address) {
        return ECDSA.recover(orderHash, signature);
    }

    /**
    * @notice checks `x` is non-zero and whether `x` is multiple of `y`
    * @dev assumes y is positive
    * @return `true` if `x` is multiple of `y` and abs(x) >= y
    */
    function isMultiple(int256 x, int256 y) internal pure returns (bool) {
        return (x != 0 && x % y == 0);
    }

    /**
    * @notice returns true if x and y have opposite signs
    * @dev it considers 0 to have positive sign
    */
    function isOppositeSign(int256 x, int256 y) internal pure returns (bool) {
        return (x ^ y) < 0;
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function setIOCOrderBook(address _iocOrderBook) external onlyGovernance {
        iocOrderBook = IImmediateOrCancelOrders(_iocOrderBook);
    }

    function setOrderBookRollup(address _orderBookRollup) external onlyGovernance {
        orderBookRollup = IOrderBookRollup(_orderBookRollup);
    }
}
