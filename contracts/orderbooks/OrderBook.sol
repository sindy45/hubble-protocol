// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { ECDSAUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { VanillaGovernable } from "../legos/Governable.sol";
import { IClearingHouse, IOrderBook, IAMM, IMarginAccount } from "../Interfaces.sol";
import { IHubbleBibliophile } from "../precompiles/IHubbleBibliophile.sol";

/**
 * @title Takes care of order placement, matching, cancellations and liquidations.
 *        Mostly has only first level checks about validatiy of orders. More deeper checks and interactions happen in ClearingHouse.
 * @notice This contract is used by users to place/cancel orders and by validators to relay matched/liquidation orders
 * @dev At several places we are using something called a bibliophile. This is a special contract (precompile) that is deployed at a specific address.
 * But there is identical code in this contract that can be used as a fallback if the precompile is not available.
*/
contract OrderBook is IOrderBook, VanillaGovernable, Pausable, EIP712Upgradeable {
    using SafeCast for uint256;
    using SafeCast for int256;

    // keccak256("Order(uint256 ammIndex,address trader,int256 baseAssetQuantity,uint256 price,uint256 salt,bool reduceOnly)");
    bytes32 public constant ORDER_TYPEHASH = 0x0a2e4d36552888a97d5a8975ad22b04e90efe5ea0a8abb97691b63b431eb25d2;
    string constant NOT_IS_MULTIPLE = "OB.not_multiple";

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable marginAccount;

    mapping(bytes32 => OrderInfo) public orderInfo; // SLOT_53 !!! used in precompile !!!
    mapping(address => bool) public isValidator; // SLOT_54 (not used in precompile)

    /**
    * @notice maps the address of the trader to the amount of reduceOnlyAmount for each amm
    * trader => ammIndex => reduceOnlyAmount
    */
    mapping(address => mapping(uint => int256)) public reduceOnlyAmount;

    // cache some variables for quick assertions
    int256[] public minSizes; // min size for each AMM, array index is the ammIndex
    uint public minAllowableMargin;
    uint public takerFee;
    IHubbleBibliophile public bibliophile;

    uint256 public useNewPricingAlgorithm; // declared as uint256 to take 1 full slot

    // trader => tradingAuthority => true/false
    mapping(address => mapping(address => bool)) public isTradingAuthority;

    uint256[48] private __gap;

    modifier onlyValidator {
        require(isValidator[msg.sender], "OB.only_validator");
        _;
    }

    modifier onlyClearingHouse {
        require(msg.sender == address(clearingHouse), "OB.only_clearingHouse");
        _;
    }

    constructor(address _clearingHouse, address _marginAccount) {
        clearingHouse = IClearingHouse(_clearingHouse);
        marginAccount = IMarginAccount(_marginAccount);
    }

    function initialize(
        string memory _name,
        string memory _version,
        address _governance
    ) external initializer {
        __EIP712_init(_name, _version);
        _setGovernace(_governance);
    }

    /* ****************** */
    /*    Place Orders    */
    /* ****************** */

    /**
     * @inheritdoc IOrderBook
    */
    function placeOrder(Order memory order) external {
        Order[] memory _orders = new Order[](1);
        _orders[0] = order;
        placeOrders(_orders);
    }

    /**
     * @inheritdoc IOrderBook
    */
    function placeOrders(Order[] memory orders) public whenNotPaused {
        address sender = _msgSender();
        address trader = orders[0].trader;
        require(sender == trader || isTradingAuthority[trader][sender], "OB.not_trader_or_tradingAuthority");
        (int[] memory posSizes, uint[] memory upperBounds) = _getPositionSizesAndUpperBoundsForMarkets(trader);
        uint reserveAmount;
        for (uint i = 0; i < orders.length; i++) {
            require(orders[i].trader == trader, "OB_trader_mismatch");
            reserveAmount += _placeOrder(orders[i], posSizes[orders[i].ammIndex], upperBounds[orders[i].ammIndex]);
        }
        if (reserveAmount != 0) {
            marginAccount.reserveMargin(trader, reserveAmount);
        }
    }

    function _getPositionSizes(address trader) internal view returns (int[] memory posSizes) {
        (posSizes,) = _getPositionSizesAndUpperBoundsForMarkets(trader);
    }

    function _getPositionSizesAndUpperBoundsForMarkets(address trader) internal view returns(int[] memory posSizes, uint[] memory upperBounds) {
        address _precompile = address(bibliophile);
        if (_precompile != address(0)) {
            // precompile magic allows us to execute this for a fixed gas
            return IHubbleBibliophile(_precompile).getPositionSizesAndUpperBoundsForMarkets(trader);
        }
        // folowing is the fallback code if precompile is not available. Precompile is intended to perform the same computation as the following code
        uint numAmms = clearingHouse.getAmmsLength();
        posSizes = new int[](numAmms);
        upperBounds = new uint[](numAmms);
        for (uint i; i < numAmms; ++i) {
            IAMM amm = IAMM(clearingHouse.amms(i));
            (posSizes[i],,,) = amm.positions(trader);
            uint spreadLimit = amm.maxOracleSpreadRatio();
            uint256 oraclePrice = amm.getUnderlyingPrice();
            upperBounds[i] = oraclePrice * (1e6 + spreadLimit) / 1e6;
        }
    }

    /**
     * @dev has some special handling for reduceOnly orders
    */
    function _placeOrder(Order memory order, int size, uint upperBound) internal returns (uint reserveAmount) {
        // orders should be multiple of pre-defined minimum quantity to prevent spam with dust orders
        require(isMultiple(order.baseAssetQuantity, minSizes[order.ammIndex]), NOT_IS_MULTIPLE);

        bytes32 orderHash = getOrderHash(order);
        // order should not exist in the orderStatus map already
        require(orderInfo[orderHash].status == OrderStatus.Invalid, "OB_Order_already_exists");

        // reduce only orders should only reduce the position size. They need a bit of special handling.
        if (order.reduceOnly) {
            require(isOppositeSign(size, order.baseAssetQuantity), "OB_reduce_only_order_must_reduce_position");
            // track the total size of all the reduceOnly orders for a trader in a particular market
            reduceOnlyAmount[order.trader][order.ammIndex] += abs(order.baseAssetQuantity);
            // total size of reduce only orders should not exceed the position size
            require(abs(size) >= reduceOnlyAmount[order.trader][order.ammIndex], "OB_reduce_only_amount_exceeded");
        } else {
            /**
            * Don't allow trade in opposite direction of existing position size if there is a reduceOnly order
            * in case of liquidation, size == 0 && reduceOnlyAmount != 0 is possible
            * in that case, we don't not allow placing a new order in any direction, must cancel reduceOnly order first
            * in normal case, size = 0 => reduceOnlyAmount = 0
            */
            if (isOppositeSign(size, order.baseAssetQuantity) || size == 0) {
                require(reduceOnlyAmount[order.trader][order.ammIndex] == 0, "OB_cancel_reduce_only_order_first");
            }
            // reserve margin for the order
            reserveAmount = getRequiredMargin(order.baseAssetQuantity, order.price, upperBound);
        }

        // add orderInfo for the corresponding orderHash
        orderInfo[orderHash] = OrderInfo(block.number, 0, reserveAmount, OrderStatus.Placed);
        emit OrderPlaced(order.trader, orderHash, order, block.timestamp);
    }

    /* ****************** */
    /*    Cancel Orders   */
    /* ****************** */

    /**
     * @inheritdoc IOrderBook
    */
    function cancelOrder(Order memory order) override external {
        Order[] memory _orders = new Order[](1);
        _orders[0] = order;
        cancelOrders(_orders);
    }

    /**
     * @inheritdoc IOrderBook
    */
    function cancelOrders(Order[] memory orders) override public {
        address trader = orders[0].trader;
        uint releaseMargin;
        for (uint i; i < orders.length; i++) {
            require(orders[i].trader == trader, "OB_trader_mismatch");
            releaseMargin += _cancelOrder(orders[i]);
        }
        if (releaseMargin != 0) {
            marginAccount.releaseMargin(trader, releaseMargin);
        }
    }

    function _cancelOrder(Order memory order) internal returns (uint releaseMargin) {
        bytes32 orderHash = getOrderHash(order);
        require(orderInfo[orderHash].status == OrderStatus.Placed, "OB_Order_does_not_exist");

        address trader = order.trader;
        if (msg.sender != trader) {
            require(isValidator[msg.sender], "OB_invalid_sender");
            // allow cancellation of order by validator if availableMargin < 0
            // there is more information in the description of the function
            require(marginAccount.getAvailableMargin(trader) < 0, "OB_available_margin_not_negative");
        }

        orderInfo[orderHash].status = OrderStatus.Cancelled;
        if (order.reduceOnly) {
            int unfilledAmount = abs(order.baseAssetQuantity - orderInfo[orderHash].filledAmount);
            reduceOnlyAmount[trader][order.ammIndex] -= unfilledAmount;
        } else {
            releaseMargin = orderInfo[orderHash].reservedMargin;
        }

        _deleteOrderInfo(orderHash);
        emit OrderCancelled(trader, orderHash, block.timestamp);
    }

    /* ****************** */
    /*    Match Orders    */
    /* ****************** */

    /**
     * @inheritdoc IOrderBook
    */
    function executeMatchedOrders(
        Order[2] memory orders,
        int256 fillAmount
    )   override
        external
        whenNotPaused
        onlyValidator
    {
        IClearingHouse.Instruction[2] memory instructions;
        instructions[0] = IClearingHouse.Instruction({
            ammIndex: orders[0].ammIndex,
            trader: orders[0].trader,
            orderHash: getOrderHash(orders[0]),
            mode : IClearingHouse.OrderExecutionMode(0) // will be ovewritten
        });
        instructions[1] = IClearingHouse.Instruction({
            ammIndex: orders[1].ammIndex,
            trader: orders[1].trader,
            orderHash: getOrderHash(orders[1]),
            mode: IClearingHouse.OrderExecutionMode(0) // will be ovewritten
        });

        (uint fillPrice, OrderExecutionMode mode0, OrderExecutionMode mode1) = useNewPricingAlgorithm == 1 ?
            bibliophile.validateOrdersAndDetermineFillPrice(orders, [instructions[0].orderHash, instructions[1].orderHash], fillAmount) :
            // folowing is the fallback code if precompile is not available. Precompile is intended to perform the same computation as the following code
            _validateOrdersAndDetermineFillPrice(orders, [instructions[0].orderHash, instructions[1].orderHash], fillAmount);
        instructions[0].mode = IClearingHouse.OrderExecutionMode(uint8(mode0));
        instructions[1].mode = IClearingHouse.OrderExecutionMode(uint8(mode1));

        try clearingHouse.openComplementaryPositions(instructions, fillAmount, fillPrice) returns (uint256 openInterestNotional) {
            _updateOrder(orders[0], instructions[0].orderHash, fillAmount);
            _updateOrder(orders[1], instructions[1].orderHash, -fillAmount);
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

    /**
     * @dev validate orders and determines the fill price of the orders being matched
     * @param orders orders[0] is the long order and orders[1] is the short order
     * @param orderHashes output of getOrderHash(order)
     * @param fillAmount Amount of base asset to be traded between the two orders. Should be +ve. Scaled by 1e18
    */
    function _validateOrdersAndDetermineFillPrice(
        Order[2] memory orders,
        bytes32[2] memory orderHashes,
        int256 fillAmount
    )   internal
        view
        returns (uint256 fillPrice, OrderExecutionMode mode0, OrderExecutionMode mode1)
    {
        // Checks and Effects
        require(orders[0].baseAssetQuantity > 0, "OB_order_0_is_not_long");
        require(orders[1].baseAssetQuantity < 0, "OB_order_1_is_not_short");
        uint ammIndex = orders[0].ammIndex;
        require(ammIndex == orders[1].ammIndex, "OB_orders_for_different_amms");
        require(orders[0].price /* buy */ >= orders[1].price /* sell */, "OB_orders_do_not_match");
        require(orderInfo[orderHashes[0]].status == OrderStatus.Placed, "OB_invalid_order");
        require(orderInfo[orderHashes[1]].status == OrderStatus.Placed, "OB_invalid_order");

        int[] memory posSizes;
        if (orders[0].reduceOnly) {
            posSizes = _getPositionSizes(orders[0].trader);
            require(posSizes[ammIndex] <= -fillAmount, "OB_reduce_only_amount_exceeded");
        }
        if (orders[1].reduceOnly) {
            posSizes = _getPositionSizes(orders[1].trader);
            // fillAmount > 0, so no need to check if posSizes[orders[1].ammIndex] > 0
            require(posSizes[ammIndex] >= fillAmount, "OB_reduce_only_amount_exceeded");
        }
        // fillAmount should be multiple of min size requirement and fillAmount should be non-zero
        require(isMultiple(fillAmount, minSizes[ammIndex]), NOT_IS_MULTIPLE);

        uint blockPlaced0 = orderInfo[orderHashes[0]].blockPlaced;
        uint blockPlaced1 = orderInfo[orderHashes[1]].blockPlaced;

        if (blockPlaced0 < blockPlaced1) {
            mode0 = OrderExecutionMode.Maker;
            fillPrice = orders[0].price;
        } else if (blockPlaced0 > blockPlaced1) {
            mode1 = OrderExecutionMode.Maker;
            fillPrice = orders[1].price;
        } else { // both orders are placed in the same block, not possible to determine what came first in solidity
            // executing both orders as taker order
            mode0 = OrderExecutionMode.SameBlock;
            mode1 = OrderExecutionMode.SameBlock;
            // Bulls (Longs) are our friends. We give them a favorable price in this corner case
            fillPrice = orders[1].price;
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

    /* ****************** */
    /*    Liquidation     */
    /* ****************** */

    /**
     * @inheritdoc IOrderBook
    */
    function liquidateAndExecuteOrder(
        address trader,
        Order calldata order,
        uint256 liquidationAmount
    )   override
        external
        whenNotPaused
        onlyValidator
    {
        bytes32 orderHash = getOrderHash(order);
        require(orderInfo[orderHash].status == OrderStatus.Placed, "OB_invalid_order");
        uint fillPrice = useNewPricingAlgorithm == 1 ?
            bibliophile.validateLiquidationOrderAndDetermineFillPrice(order, liquidationAmount.toInt256()) :
            _validateLiquidationOrderAndDetermineFillPrice(order, liquidationAmount.toInt256());

        int256 fillAmount = liquidationAmount.toInt256();
        if (order.baseAssetQuantity < 0) { // order is short, so short position is being liquidated
            fillAmount *= -1;
        }

        IClearingHouse.Instruction memory instruction = IClearingHouse.Instruction({
            ammIndex: order.ammIndex,
            trader: order.trader,
            orderHash: getOrderHash(order),
            mode: IClearingHouse.OrderExecutionMode.Maker
        });
        try clearingHouse.liquidate(instruction, fillAmount, fillPrice, trader) returns (uint256 openInterestNotional) {
            _updateOrder(order, instruction.orderHash, fillAmount);
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

    function _validateLiquidationOrderAndDetermineFillPrice(Order memory order, int256 liquidationAmount) internal view returns(uint256 fillPrice) {
        // fillAmount should be multiple of min size requirement and fillAmount should be non-zero
        require(isMultiple(liquidationAmount, minSizes[order.ammIndex]), NOT_IS_MULTIPLE);
        fillPrice = order.price;
        _validateSpread(order.ammIndex, fillPrice, true);
    }

    /* ****************** */
    /*  Funding Payments  */
    /* ****************** */

    function settleFunding() external whenNotPaused onlyValidator {
        clearingHouse.settleFunding();
    }

    /* ****************** */
    /*       View         */
    /* ****************** */

    /**
     * @dev This is not being utilized in the contract anymore. It is only here for backwards compatibility.
    */
    function verifySigner(Order memory order, bytes memory signature) public view returns (address, bytes32) {
        bytes32 orderHash = getOrderHash(order);
        address signer = ECDSAUpgradeable.recover(orderHash, signature);
        require(signer == order.trader, "OB_SINT");
        return (signer, orderHash);
    }

    function getOrderHash(Order memory order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, order)));
    }

    /**
    * @notice Get the margin required to place an order
    * @dev includes trade fee (taker fee).
    * For a short order, margin is calculated using the upper bound price of the market.
    */
    function getRequiredMargin(int256 baseAssetQuantity, uint256 price, uint upperBound) public view returns(uint256 requiredMargin) {
        if (baseAssetQuantity < 0 && price < upperBound) {
            price = upperBound;
        }
        uint quoteAsset = abs(baseAssetQuantity).toUint256() * price / 1e18;
        requiredMargin = quoteAsset * minAllowableMargin / 1e6;
        requiredMargin += quoteAsset * takerFee / 1e6;
    }

    /* ****************** */
    /*      Internal      */
    /* ****************** */

    function _updateOrder(Order memory order, bytes32 orderHash, int256 fillAmount) internal {
        orderInfo[orderHash].filledAmount += fillAmount;

        // assert that the order is not being overfilled
        require(abs(orderInfo[orderHash].filledAmount) <= abs(order.baseAssetQuantity), "OB_filled_amount_higher_than_order_base");

        // update order status if filled and free up reserved margin
        if (order.reduceOnly) {
            // free up the reduceOnly quota
            reduceOnlyAmount[order.trader][order.ammIndex] -= abs(fillAmount);
            if (orderInfo[orderHash].filledAmount == order.baseAssetQuantity) {
                orderInfo[orderHash].status = OrderStatus.Filled;
                _deleteOrderInfo(orderHash);
            }
        } else {
            uint reservedMargin = orderInfo[orderHash].reservedMargin;
            if (orderInfo[orderHash].filledAmount == order.baseAssetQuantity) {
                orderInfo[orderHash].status = OrderStatus.Filled;
                marginAccount.releaseMargin(order.trader, reservedMargin);
                _deleteOrderInfo(orderHash);
            } else {
                // even though the fill price might be different from the order price;
                // we use the order price to free up the margin because the order price is the price at which the margin was reserved.
                uint utilisedMargin = uint(abs(fillAmount)) * reservedMargin / uint(abs(order.baseAssetQuantity));
                // need to track this so we can free up the margin when the order is fulfilled/cancelled without leaving any dust margin reserved from precision loss from divisions
                orderInfo[orderHash].reservedMargin -= utilisedMargin;
                marginAccount.releaseMargin(order.trader, utilisedMargin);
            }
        }
    }

    /**
    * @notice Deletes everything except status and filledAmount from orderInfo
    * @dev cannot delete order status because then same order can be placed again
    */
    function _deleteOrderInfo(bytes32 orderHash) internal {
        delete orderInfo[orderHash].blockPlaced;
        delete orderInfo[orderHash].reservedMargin;
    }

    /* ****************** */
    /*  Trading Authority */
    /* ****************** */

    /**
     * @notice Whitelist a trading authority to be able to place orders on behalf of the caller and optionally transfer some gas token to the authority
    */
    function whitelistTradingAuthority(address authority) payable external {
        isTradingAuthority[_msgSender()][authority] = true;
        if (msg.value > 0) {
            (bool success, ) = payable(authority).call{value: msg.value}("");
            require(success, "OrderBook: failed to airdrop gas to authority");
        }
    }

    /**
     * @notice Revoke trading authority of an address
    */
    function revokeTradingAuthority(address authority) external {
        isTradingAuthority[_msgSender()][authority] = false;
    }

    /* ****************** */
    /*        Pure        */
    /* ****************** */

    function abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
    }

    /**
    * @notice returns true if x and y have opposite signs
    * @dev it considers 0 to have positive sign
    */
    function isOppositeSign(int256 x, int256 y) internal pure returns (bool) {
        return (x ^ y) < 0;
    }

    /**
    * @notice checks `x` is non-zero and whether `x` is multiple of `y`
    * @dev assumes y is positive
    * @return `true` if `x` is multiple of `y` and abs(x) >= y
    */
    function isMultiple(int256 x, int256 y) internal pure returns (bool) {
        return (x != 0 && x % y == 0);
    }

    function parseMatchingError(string memory err) pure public returns(bytes32 orderHash, string memory reason) {
        (orderHash, reason) = abi.decode(bytes(err), (bytes32, string));
    }

    /* ****************** */
    /*   Config Updates   */
    /* ****************** */

    function initializeMinSize(int minSize) external onlyGovernance {
        minSizes.push(minSize);
    }

    function updateMinSize(uint ammIndex, int minSize) external onlyGovernance {
        minSizes[ammIndex] = minSize;
    }

    function updateParams(uint _minAllowableMargin, uint _takerFee) external onlyClearingHouse {
        minAllowableMargin = _minAllowableMargin;
        takerFee = _takerFee;
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

    function setValidatorStatus(address validator, bool status) external onlyGovernance {
        isValidator[validator] = status;
    }

    function setBibliophile(address _bibliophile) external onlyGovernance {
        bibliophile = IHubbleBibliophile(_bibliophile);
    }

    function setUseNewPricingAlgorithm(bool useNew) external onlyGovernance {
        if (useNew) {
            useNewPricingAlgorithm = 1;
        } else {
            useNewPricingAlgorithm = 0;
        }
    }
}
