// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { ECDSAUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { VanillaGovernable } from "../legos/Governable.sol";
import { IClearingHouse, IOrderBook, IAMM, IMarginAccount } from "../Interfaces.sol";
import { IHubbleBibliophile } from "../precompiles/IHubbleBibliophile.sol";

contract OrderBook is IOrderBook, VanillaGovernable, Pausable, EIP712Upgradeable {
    using SafeCast for uint256;
    using SafeCast for int256;

    // keccak256("Order(uint256 ammIndex,address trader,int256 baseAssetQuantity,uint256 price,uint256 salt,bool reduceOnly)");
    bytes32 public constant ORDER_TYPEHASH = 0x0a2e4d36552888a97d5a8975ad22b04e90efe5ea0a8abb97691b63b431eb25d2;
    string constant NOT_IS_MULTIPLE = "OB.not_multiple";

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable marginAccount;

    mapping(bytes32 => OrderInfo) public orderInfo;
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

    uint256[50] private __gap;

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
        // this is problematic for re-initialization but as long as we are not changing gov address across runs, it wont be a problem
        _setGovernace(_governance);
    }

    function executeMatchedOrders(
        Order[2] memory orders,
        int256 fillAmount
    )   override
        external
        whenNotPaused
        onlyValidator
    {
        MatchInfo[2] memory matchInfo;
        matchInfo[0].orderHash = getOrderHash(orders[0]);
        matchInfo[0].blockPlaced = orderInfo[matchInfo[0].orderHash].blockPlaced;
        _validateOrder(matchInfo[0].orderHash);

        matchInfo[1].orderHash = getOrderHash(orders[1]);
        matchInfo[1].blockPlaced = orderInfo[matchInfo[1].orderHash].blockPlaced;
        _validateOrder(matchInfo[1].orderHash);

        _executeMatchedOrders(orders, matchInfo, fillAmount);
    }

    function _validateOrder(bytes32 orderHash) internal view {
        require(orderInfo[orderHash].status == OrderStatus.Placed, "OB_invalid_order");
    }

    /**
     * Execute matched orders
     * @param orders It is required that orders[0] is a LONG and orders[1] is a SHORT
     * @param fillAmount Amount to be filled for each order. This is to support partial fills.
     *        Should be non-zero multiple of minSizeRequirement (validated in _verifyOrder)
    */
    function _executeMatchedOrders(
        Order[2] memory orders,
        MatchInfo[2] memory matchInfo,
        int256 fillAmount
    )   internal
    {
        // Checks and Effects
        require(orders[0].baseAssetQuantity > 0, "OB_order_0_is_not_long");
        require(orders[1].baseAssetQuantity < 0, "OB_order_1_is_not_short");
        require(orders[0].price /* buy */ >= orders[1].price /* sell */, "OB_orders_do_not_match");
        require(orders[0].ammIndex == orders[1].ammIndex, "OB_orders_for_different_amms");
        // fillAmount should be multiple of min size requirement and fillAmount should be non-zero
        require(isMultiple(fillAmount, minSizes[orders[0].ammIndex]), NOT_IS_MULTIPLE);

        // Interactions
        uint fulfillPrice;
        if (matchInfo[0].blockPlaced < matchInfo[1].blockPlaced) {
            matchInfo[0].mode = OrderExecutionMode.Maker;
            fulfillPrice = orders[0].price;
        } else if (matchInfo[0].blockPlaced > matchInfo[1].blockPlaced) {
            matchInfo[1].mode = OrderExecutionMode.Maker;
            fulfillPrice = orders[1].price;
        } else { // both orders are placed in the same block, not possible to determine what came first in solidity
            // executing both orders as taker order
            matchInfo[0].mode = OrderExecutionMode.SameBlock;
            matchInfo[1].mode = OrderExecutionMode.SameBlock;
            // Bulls (Longs) are our friends. We give them a favorable price in this corner case
            fulfillPrice = orders[1].price;
        }

        try clearingHouse.openComplementaryPositions(orders, matchInfo, fillAmount, fulfillPrice) {
            _updateOrder(orders[0], matchInfo[0].orderHash, fillAmount);
            _updateOrder(orders[1], matchInfo[1].orderHash, -fillAmount);
            // get openInterestNotional for indexing
            // @todo move this to precompile
            IAMM amm = clearingHouse.amms(orders[0].ammIndex);
            uint openInterestNotional = amm.openInterestNotional();
            emit OrdersMatched(matchInfo[0].orderHash, matchInfo[1].orderHash, fillAmount.toUint256() /* asserts fillAmount is +ve */, fulfillPrice, openInterestNotional, msg.sender, block.timestamp);
        } catch Error(string memory err) { // catches errors emitted from "revert/require"
            try this.parseMatchingError(err) returns(bytes32 orderHash, string memory reason) {
                emit OrderMatchingError(orderHash, reason);
            } catch (bytes memory) {
                // abi.decode failed; we bubble up the original err
                revert(err);
            }
            return;
        } /* catch (bytes memory err) {
            // we do not any special handling for other generic type errors
            // they can revert the entire tx as usual
        } */
    }

    function placeOrder(Order memory order) external {
        Order[] memory _orders = new Order[](1);
        _orders[0] = order;
        placeOrders(_orders);
    }

    function placeOrders(Order[] memory orders) public whenNotPaused {
        address trader = orders[0].trader;
        int[] memory posSizes = _getPositionSizes(trader);
        uint reserveAmount;
        for (uint i = 0; i < orders.length; i++) {
            require(orders[i].trader == trader, "OB_trader_mismatch");
            reserveAmount += _placeOrder(orders[i], posSizes[orders[i].ammIndex]);
        }
        if (reserveAmount != 0) {
            marginAccount.reserveMargin(trader, reserveAmount);
        }
    }

    function _getPositionSizes(address trader) internal view returns (int[] memory) {
        if (address(bibliophile) != address(0)) {
            // precompile magic allows us to execute this for a fixed 1k gas
            return bibliophile.getPositionSizes(trader);
        }
        uint numAmms = clearingHouse.getAmmsLength();
        int[] memory posSizes = new int[](numAmms);
        for (uint i; i < numAmms; ++i) {
            (posSizes[i],,,) = IAMM(clearingHouse.amms(i)).positions(trader);
        }
        return posSizes;
    }

    function _placeOrder(Order memory order, int size) internal returns (uint reserveAmount) {
        require(msg.sender == order.trader, "OB_sender_is_not_trader");
        // require(order.validUntil == 0, "OB_expiring_orders_not_supported");
        // order.baseAssetQuantity should be multiple of minSizeRequirement
        require(isMultiple(order.baseAssetQuantity, minSizes[order.ammIndex]), NOT_IS_MULTIPLE);

        bytes32 orderHash = getOrderHash(order);
        // order should not exist in the orderStatus map already
        require(orderInfo[orderHash].status == OrderStatus.Invalid, "OB_Order_already_exists");

        if (order.reduceOnly) {
            require(isOppositeSign(size, order.baseAssetQuantity), "OB_reduce_only_order_must_reduce_position");
            reduceOnlyAmount[order.trader][order.ammIndex] += abs(order.baseAssetQuantity);
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
            reserveAmount = getRequiredMargin(order.baseAssetQuantity, order.price);
        }

        // add orderInfo for the corresponding orderHash
        orderInfo[orderHash] = OrderInfo(block.number, 0, reserveAmount, OrderStatus.Placed);
        emit OrderPlaced(order.trader, orderHash, order, block.timestamp);
    }

    function cancelOrder(Order memory order) override external {
        Order[] memory _orders = new Order[](1);
        _orders[0] = order;
        cancelOrders(_orders);
    }

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
        // order status should be placed
        require(orderInfo[orderHash].status == OrderStatus.Placed, "OB_Order_does_not_exist");

        address trader = order.trader;
        if (msg.sender != trader) {
            require(isValidator[msg.sender], "OB_invalid_sender");
            // allow cancellation of order by validator if availableMargin < 0
            require(marginAccount.getAvailableMargin(trader) < 0, "OB_available_margin_not_negative");
        }

        orderInfo[orderHash].status = OrderStatus.Cancelled;
        // update reduceOnlyAmount
        if (order.reduceOnly) {
            int unfilledAmount = abs(order.baseAssetQuantity - orderInfo[orderHash].filledAmount);
            reduceOnlyAmount[trader][order.ammIndex] -= unfilledAmount;
        } else {
            releaseMargin = orderInfo[orderHash].reservedMargin;
        }

        _deleteOrderInfo(orderHash);
        emit OrderCancelled(trader, orderHash, block.timestamp);
    }

    function settleFunding() external whenNotPaused onlyValidator {
        clearingHouse.settleFunding();
    }

    /**
     * @dev assuming one order is in liquidation zone and other is out of it
     * @notice liquidate trader
     * @param trader trader to liquidate
     * @param order order to match when liquidating for a particular amm
     * @param liquidationAmount baseAsset amount being traded/liquidated.
     *        liquidationAmount!=0 is validated in amm.liquidatePosition
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
        _validateOrder(orderHash);
        int256 fillAmount = liquidationAmount.toInt256();
        if (order.baseAssetQuantity < 0) { // order is short, so short position is being liquidated
            fillAmount *= -1;
        }
        // fillAmount should be multiple of min size requirement and fillAmount should be non-zero
        require(isMultiple(fillAmount, minSizes[order.ammIndex]), NOT_IS_MULTIPLE);

        MatchInfo memory matchInfo = MatchInfo({
            orderHash: orderHash,
            blockPlaced: orderInfo[orderHash].blockPlaced,
            mode: OrderExecutionMode.Maker // execute matching order as maker order
        });

        try clearingHouse.liquidate(order, matchInfo, fillAmount, order.price, trader) {
            _updateOrder(order, matchInfo.orderHash, fillAmount);
            // get openInterestNotional for indexing
            IAMM amm = clearingHouse.amms(order.ammIndex);
            uint openInterestNotional = amm.openInterestNotional();
            emit LiquidationOrderMatched(trader, matchInfo.orderHash, liquidationAmount, order.price, openInterestNotional, msg.sender, block.timestamp);
        } catch Error(string memory err) { // catches errors emitted from "revert/require"
            try this.parseMatchingError(err) returns(bytes32 _orderHash, string memory reason) {
                if (matchInfo.orderHash == _orderHash) { // err in openPosition for the order
                    emit OrderMatchingError(_orderHash, reason);
                    reason = "OrderMatchingError";
                } // else err in liquidating the trader; but we emit this either ways so that we can track liquidation didnt succeed for whatever reason
                emit LiquidationError(trader, _orderHash, reason, liquidationAmount);
            } catch (bytes memory) {
                // abi.decode failed; we bubble up the original err
                revert(err);
            }
            return;
        } /* catch (bytes memory err) {
            // we do not any special handling for other generic type errors
            // they can revert the entire tx as usual
        } */
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

    /**
    * @notice Get the margin required to place an order
    * @dev includes trade fee (taker fee)
    */
    function getRequiredMargin(int256 baseAssetQuantity, uint256 price) public view returns(uint256 requiredMargin) {
        uint quoteAsset = abs(baseAssetQuantity).toUint256() * price / 1e18;
        requiredMargin = quoteAsset * minAllowableMargin / 1e6;
        requiredMargin += quoteAsset * takerFee / 1e6;
    }

    /* ****************** */
    /*      Internal      */
    /* ****************** */

    function _updateOrder(Order memory order, bytes32 orderHash, int256 fillAmount) internal {
        orderInfo[orderHash].filledAmount += fillAmount;
        require(abs(orderInfo[orderHash].filledAmount) <= abs(order.baseAssetQuantity), "OB_filled_amount_higher_than_order_base");

        // update order status if filled and free up reserved margin
        if (order.reduceOnly) {
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
                uint utilisedMargin = uint(abs(fillAmount)) * reservedMargin / uint(abs(order.baseAssetQuantity));
                orderInfo[orderHash].reservedMargin -= utilisedMargin;
                marginAccount.releaseMargin(order.trader, utilisedMargin);
            }
        }
    }

    /**
    * @notice deletes everything except status and filledAmount from orderInfo
    * @dev cannot delete order status because then same order can be placed again
    */
    function _deleteOrderInfo(bytes32 orderHash) internal {
        delete orderInfo[orderHash].blockPlaced;
        delete orderInfo[orderHash].reservedMargin;
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
    * @notice returns true if x is multiple of y and abs(x) >= y
    * @dev assumes y is positive
    */
    function isMultiple(int256 x, int256 y) internal pure returns (bool) {
        return (x != 0 && x % y == 0);
    }

    function parseMatchingError(string memory err) pure public returns(bytes32 orderHash, string memory reason) {
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

    function setValidatorStatus(address validator, bool status) external onlyGovernance {
        isValidator[validator] = status;
    }

    function initializeMinSize(int minSize) external onlyGovernance {
        minSizes.push(minSize);
    }

    function updateMinSize(uint ammIndex, int minSize) external onlyGovernance {
        minSizes[ammIndex] = minSize;
    }

    function setBibliophile(address _bibliophile) external onlyGovernance {
        bibliophile = IHubbleBibliophile(_bibliophile);
    }

    function updateParams(uint _minAllowableMargin, uint _takerFee) external {
        require(msg.sender == address(clearingHouse), "OB_only_clearingHouse");
        minAllowableMargin = _minAllowableMargin;
        takerFee = _takerFee;
    }
}
