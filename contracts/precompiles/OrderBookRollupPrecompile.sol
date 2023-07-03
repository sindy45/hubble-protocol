// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { IClearingHouse, IAMM, IMarginAccount } from "../Interfaces.sol";
import { IOrderBookRollup } from "../orderbooks/OrderBookRollup.sol";

interface IOrderBookRollupPrecompile {
    enum OrderType {
        Long,
        Short
    }

    function validateCancelOrders(IOrderBookRollup.Order[] calldata orders, address sender) external view returns(bytes32[] memory orderHashes);
    function validateOrdersAndDetermineFillPrice(
        IOrderBookRollup.Order[2] calldata orders,
        bytes[2] calldata signatures,
        int256 fillAmount,
        address validator,
        address orderbook
    ) external view returns (uint fillPrice, IClearingHouse.Instruction[2] memory instructions);
    function validateLiquidationOrderAndDetermineFillPrice(
        IOrderBookRollup.Order calldata order,
        bytes calldata signature,
        int256 liquidationAmount,
        address validator,
        address orderbook
    ) external view returns(uint256 fillPrice, IClearingHouse.Instruction memory instruction);
    function validateOrder(IOrderBookRollup.Order memory order, bytes memory signature, int256 fillAmount, OrderType orderType, address orderbook) external view returns(bytes32 orderHash);
    function getOrderHash(IOrderBookRollup.Order calldata order) external view returns(bytes32 orderHash);
}

contract OrderBookRollupPrecompile is IOrderBookRollupPrecompile, EIP712 {
    using SafeCast for uint256;
    using SafeCast for int256;

    // keccak256("Order(uint256 ammIndex,address trader,int256 baseAssetQuantity,uint256 price,uint256 salt,bool reduceOnly)");
    bytes32 public constant ORDER_TYPEHASH = 0x0a2e4d36552888a97d5a8975ad22b04e90efe5ea0a8abb97691b63b431eb25d2; // @todo this typehash is incorrect because it doesnt have validUntil
    string constant NOT_IS_MULTIPLE = "not_multiple";

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable marginAccount; // currently unused

    constructor(address _clearingHouse, address _marginAccount) EIP712("Hubble", "2.0") {
        clearingHouse = IClearingHouse(_clearingHouse);
        marginAccount = IMarginAccount(_marginAccount);
    }

    /**
     * @notice verifies whether `sender` is a valid trading authority for trader for whom the order is being cancelled
    */
    function validateCancelOrders(IOrderBookRollup.Order[] calldata orders, address sender) external view returns(bytes32[] memory orderHashes) {
        orderHashes = new bytes32[](orders.length);
        for (uint i; i < orderHashes.length; i++) {
            require(sender == orders[i].trader || isTradingAuthority(sender, orders[i].trader), "not_trading_authority");
            orderHashes[i] = getOrderHash(orders[i]);
        }
    }

    /**
     * @notice validate orders and determines the fill price of the orders being matched
     * @dev The logic for determining which one is a maker order is mocked. Real logic lies in the precompile
     * Following checks are performed:
     * 1. `validator` is whitelisted
     * 2. All checks in validateOrder()
     * 3. orders are for the same market
     * 4. orders have a price overlap
     * 5. `fillAmount` is multiple of min size requirement
     * 6. whether both traders have enough margin for this order pair to be executed (todo)
     * @param orders orders[0] is the long order and orders[1] is the short order
     * @param fillAmount Amount of base asset to be traded between the two orders. Should be +ve. Scaled by 1e18
    */
    function validateOrdersAndDetermineFillPrice(
        IOrderBookRollup.Order[2] calldata orders,
        bytes[2] calldata signatures,
        int256 fillAmount,
        address validator,
        address orderbook
    )   external view returns (uint fillPrice, IClearingHouse.Instruction[2] memory instructions)
    {
        // check 1
        require(isValidator(validator), "OB_invalid_validator");

        // check 2
        instructions[0] = IClearingHouse.Instruction({
            ammIndex: orders[0].ammIndex,
            trader: orders[0].trader,
            orderHash: validateOrder(orders[0], signatures[0], fillAmount, IOrderBookRollupPrecompile.OrderType.Long, orderbook),
            mode : IClearingHouse.OrderExecutionMode.Maker // for this mock we always execute the long order as maker order
        });
        instructions[1] = IClearingHouse.Instruction({
            ammIndex: orders[1].ammIndex,
            trader: orders[1].trader,
            orderHash: validateOrder(orders[1], signatures[1], fillAmount, IOrderBookRollupPrecompile.OrderType.Short, orderbook),
            mode : IClearingHouse.OrderExecutionMode.Taker
        });

        // check 3
        require(orders[0].ammIndex == orders[1].ammIndex, "OB_orders_for_different_amms");

        // check 4
        require(orders[0].price /* buy */ >= orders[1].price /* sell */, "OB_orders_do_not_match");

        // check 5 - we don't do this in validateOrder to avoid checking it twice
        require(isMultiple(fillAmount, IAMM(clearingHouse.amms(orders[0].ammIndex)).minSizeRequirement().toInt256()), NOT_IS_MULTIPLE);

        // check 6
        // @todo

        fillPrice = orders[0].price; // mocked logic - long order is the maker order
        validateSpread(orders[0].ammIndex, fillPrice, false);
    }

    /* ****************** */
    /*    Liquidation     */
    /* ****************** */

    function validateLiquidationOrderAndDetermineFillPrice(
        IOrderBookRollup.Order calldata order,
        bytes calldata signature,
        int256 liquidationAmount,
        address validator,
        address orderbook
    ) external view returns(uint256 fillPrice, IClearingHouse.Instruction memory instruction) {
        require(isValidator(validator), "OB_invalid_validator");

        instruction = IClearingHouse.Instruction({
            ammIndex: order.ammIndex,
            trader: order.trader,
            orderHash: "0x0",
            mode : IClearingHouse.OrderExecutionMode.Maker // execute matching order as maker order
        });

        if (order.baseAssetQuantity > 0) {
            instruction.orderHash = validateOrder(order, signature, liquidationAmount, IOrderBookRollupPrecompile.OrderType.Long, orderbook);
        } else if (order.baseAssetQuantity < 0) {
            instruction.orderHash = validateOrder(order, signature, -liquidationAmount, IOrderBookRollupPrecompile.OrderType.Short, orderbook);
        } else {
            revert("OB_liquidation_order_has_zero_base_asset_quantity");
        }

        // fillAmount should be multiple of min size requirement and fillAmount should be non-zero
        require(isMultiple(liquidationAmount, IAMM(clearingHouse.amms(order.ammIndex)).minSizeRequirement().toInt256()), NOT_IS_MULTIPLE);

        fillPrice = order.price;
        validateSpread(order.ammIndex, fillPrice, true);
    }

    /* ****************** */
    /*     Public View    */
    /* ****************** */

    function isTradingAuthority(address sender, address trader) public view returns(bool) {
        return clearingHouse.orderBook().isTradingAuthority(sender, trader);
    }

    /**
     * @notice perform the following checks on the order:
     * 1. not expired
     * 2. either signed by the trader himself or a valid pre-whitelisted trading authority
     * 3. not cancelled
     * 4. Base asset quantity is not < 0 or > 0 depending on the order type
     * 5. order will not be over filled
     * 6. reduceOnly order is not increasing position size (todo)
     * @param orderbook address of the orderbook, to query orderbook.isTradingAuthority(signer, order.trader)
    */
    function validateOrder(IOrderBookRollup.Order memory order, bytes memory signature, int256 fillAmount, IOrderBookRollupPrecompile.OrderType orderType, address orderbook) public view returns(bytes32 orderHash) {
        require(block.timestamp <= order.validUntil, "order_expired");

        address signer;
        (signer, orderHash) = verifySigner(order, signature);
        require(signer == order.trader || isTradingAuthority(signer, order.trader), "invalid_signer");

        IOrderBookRollup.OrderInfo memory orderInfo = IOrderBookRollup(orderbook).orderStatus(orderHash);
        require(orderInfo.isCancelled == false, "order_cancelled");
        if (orderType == IOrderBookRollupPrecompile.OrderType.Long) {
            require(fillAmount > 0, "invalid_fill_amount");
            require(order.baseAssetQuantity > 0, "invalid_base_asset_quantity");
            require(orderInfo.filledAmount + fillAmount <= order.baseAssetQuantity, "order_overfilled");
        } else if (orderType == IOrderBookRollupPrecompile.OrderType.Short) {
            require(fillAmount < 0, "invalid_fill_amount");
            require(order.baseAssetQuantity < 0, "invalid_base_asset_quantity");
            require(orderInfo.filledAmount + fillAmount >= order.baseAssetQuantity, "order_overfilled"); // all 3 quantities are -ve
        }
    }

    /**
     * @dev Check whether a given price is within a pre-defined % deviation from the index price of the market.
     * This is to prevent malicious actors from manipulating the price too much
     * @param ammIndex Market index
     * @param price chosen fill price
     * @param isLiquidation whether we should assert for a liquidation match or regular order match, because liquidation has a tigher spread requirement
    */
    function validateSpread(uint ammIndex, uint256 price, bool isLiquidation) public view {
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

    function getOrderHash(IOrderBookRollup.Order memory order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, order)));
    }

    /**
     * @dev This is not being utilized in the contract anymore. It is only here for backwards compatibility.
    */
    function verifySigner(IOrderBookRollup.Order memory order, bytes memory signature) public view returns (address, bytes32) {
        bytes32 orderHash = getOrderHash(order);
        address signer = ECDSA.recover(orderHash, signature);
        return (signer, orderHash);
    }

    function isValidator(address validator) public view returns(bool) {
        return clearingHouse.orderBook().isValidator(validator);
    }

    /* ****************** */
    /*        Pure        */
    /* ****************** */

    /**
    * @notice checks `x` is non-zero and whether `x` is multiple of `y`
    * @dev assumes y is positive
    * @return `true` if `x` is multiple of `y` and abs(x) >= y
    */
    function isMultiple(int256 x, int256 y) internal pure returns (bool) {
        return (x != 0 && x % y == 0);
    }
}
