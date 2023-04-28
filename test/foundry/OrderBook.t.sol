// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "./Utils.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

contract OrderBookTests is Utils {
    RestrictedErc20 public weth;
    int public constant defaultWethPrice = 1000 * 1e6;

    event OrderPlaced(address indexed trader, bytes32 indexed orderHash, IOrderBook.Order order, bytes signature, uint timestamp);
    event OrderCancelled(address indexed trader, bytes32 indexed orderHash, uint timestamp);
    event OrdersMatched(bytes32 indexed orderHash0, bytes32 indexed orderHash1, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);
    event LiquidationOrderMatched(address indexed trader, bytes32 indexed orderHash, bytes signature, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);

    function setUp() public {
        setupContracts();
        // add collateral
        weth = setupRestrictedTestToken('Hubble Ether', 'WETH', 18);

        vm.startPrank(governance);
        orderBook.setValidatorStatus(address(this), true);
        oracle.setUnderlyingPrice(address(weth), defaultWethPrice);
        marginAccount.whitelistCollateral(address(weth), 1e6);
        vm.stopPrank();
    }

    function testPlaceOrder(uint128 traderKey, int size, uint price) public {
        uint minSize = amm.minSizeRequirement();
        vm.assume(traderKey != 0 && stdMath.abs(size) >= minSize && size != type(int).min /** abs(size) fails */ && price < type(uint).max / stdMath.abs(size) && price > 1e6);
        (address trader, IOrderBook.Order memory order, bytes memory signature, bytes32 orderHash) = prepareOrder(0, traderKey, int(minSize - 1), price, false);

        vm.expectRevert("OB_sender_is_not_trader");
        orderBook.placeOrder(order, signature);

        vm.startPrank(trader);
        vm.expectRevert("OB_order_size_too_small");
        orderBook.placeOrder(order, signature);
        vm.stopPrank();

        (trader, order, signature, orderHash) = prepareOrder(0, traderKey, size, price, false);

        uint quote = stdMath.abs(size) * price / 1e18;
        uint marginRequired = quote / 5 + quote * uint(takerFee) / 1e6;
        addMargin(trader, marginRequired - 1, 0, address(0));

        vm.startPrank(trader);
        vm.expectRevert("MA_reserveMargin: Insufficient margin");
        orderBook.placeOrder(order, signature);
        vm.stopPrank();

        addMargin(trader, 1, 0, address(0));
        vm.startPrank(trader);
        vm.expectEmit(true, true, false, true, address(orderBook));
        emit OrderPlaced(trader, orderHash, order, signature, block.timestamp);
        orderBook.placeOrder(order, signature);

        vm.expectRevert("OB_Order_already_exists");
        orderBook.placeOrder(order, signature);

        (
            IOrderBook.Order memory _order,
            uint blockPlaced,
            int filledAmount,
            uint256 reservedMargin,
            OrderBook.OrderStatus status
        ) = orderBook.orderInfo(orderHash);

        assertEq(abi.encode(order), abi.encode(_order));
        assertEq(uint(status), 1); // placed
        assertEq(blockPlaced, block.number);
        assertEq(filledAmount, 0);
        assertEq(reservedMargin, marginRequired);
        assertEq(marginAccount.reservedMargin(trader), marginRequired);

        order.salt += 1;
        vm.expectRevert("OB_SINT"); // Signature and order doesn't match
        orderBook.placeOrder(order, signature);

        order.salt -= 1;
        orderBook.cancelOrder(orderHash);
        (_order, blockPlaced, filledAmount, reservedMargin, status) = orderBook.orderInfo(orderHash);
        assertEq(abi.encode(_order), abi.encode(IOrderBook.Order(0, address(0), 0, 0, 0, false)));
        assertEq(blockPlaced, 0);
        assertEq(filledAmount, 0);
        assertEq(reservedMargin, 0);
        assertEq(uint(status), 3); // cancelled
        assertEq(marginAccount.reservedMargin(trader), 0);

        // cannot place same order after cancelling
        vm.expectRevert("OB_Order_already_exists");
        orderBook.placeOrder(order, signature);
        vm.stopPrank();
    }

    // used uint32 for price here to avoid many rejections in vm.assume
    // assuming index price is fixed and mark price moves aruond it
    function testExecuteMatchedOrdersFixedIP(uint32 price, uint120 size_) public {
        {
            uint oraclePrice = uint(oracle.getUnderlyingPrice(address(wavax)));
            uint maxOracleSpreadRatio = amm.maxOracleSpreadRatio();
            uint upperLimit = oraclePrice * (1e6 + maxOracleSpreadRatio) / 1e6 - 2;
            uint lowerLimit = oraclePrice * (1e6 - maxOracleSpreadRatio) / 1e6 + 2;
            vm.assume(price < upperLimit && price > lowerLimit);
        }

        IOrderBook.Order[2] memory orders;
        bytes[2] memory signatures;
        bytes32[2] memory orderHashes;

        int size = int(uint(size_) + amm.minSizeRequirement()); // to avoid min size error

        uint quote = stdMath.abs(size) * price / 1e18;
        addMargin(alice, quote / 2, 0, address(0)); // 2x leverage
        addMargin(bob, quote / 2, 0, address(0));

        (orders[0], signatures[0], orderHashes[0]) = placeOrder(0, aliceKey, size, price, false);
        (orders[1], signatures[1], orderHashes[1]) = placeOrder(0, bobKey, -size, price, false);

        // assert reserved margin
        uint marginRequired = quote / 5 + quote * uint(takerFee) / 1e6;
        assertEq(marginAccount.reservedMargin(alice), marginRequired);
        assertEq(marginAccount.reservedMargin(bob), marginRequired);

        vm.expectRevert("OB_filled_amount_higher_than_order_base");
        orderBook.executeMatchedOrders(orders, signatures, size + 1);

        vm.expectEmit(true, true, false, true, address(orderBook));
        emit OrdersMatched(orderHashes[0], orderHashes[1], uint(size), uint(price), stdMath.abs(2 * size), address(this), block.timestamp);
        orderBook.executeMatchedOrders(orders, signatures, size);

        IOrderBook.Order memory order;
        int filledAmount;
        OrderBook.OrderStatus status;
        (order, temp[0] /** block placed */, filledAmount, temp[1] /** reservedMargin */, status) = orderBook.orderInfo(orderHashes[0]);
        // assert that order, blockPlaced, reservedMargin are deleted
        assertEq(abi.encode(order), abi.encode(IOrderBook.Order(0, address(0), 0, 0, 0, false)));
        assertEq(temp[0], 0);
        assertEq(filledAmount, size);
        assertEq(temp[1], 0);
        assertEq(uint(status), 2); // filled

        (order, temp[0] /** block placed */, filledAmount, temp[1] /** reservedMargin */, status) = orderBook.orderInfo(orderHashes[1]);
        // assert that order, blockPlaced, reservedMargin are deleted
        assertEq(abi.encode(order), abi.encode(IOrderBook.Order(0, address(0), 0, 0, 0, false)));
        assertEq(temp[0], 0);
        assertEq(filledAmount, -size);
        assertEq(temp[1], 0);
        assertEq(uint(status), 2); // filled
        // all margin is freed
        assertEq(marginAccount.reservedMargin(alice), 0);
        assertEq(marginAccount.reservedMargin(bob), 0);

        vm.expectRevert("OB_invalid_order");
        orderBook.executeMatchedOrders(orders, signatures, size);

        assertPositions(alice, size, quote, 0, price);
        assertPositions(bob, -size, quote, 0, price);
    }

    // assuming mark and index price move together and exactly match
    function testExecuteMatchedOrdersMovingIP(uint64 price, uint120 size_) public {
        vm.assume(price != 0);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_) + 2 * amm.minSizeRequirement()); // to avoid min size error

        IOrderBook.Order[2] memory orders;
        bytes[2] memory signatures;
        bytes32[2] memory orderHashes;

        uint quote = stdMath.abs(size) * price / 1e18;
        addMargin(alice, quote / 2, 0, address(0)); // 2x leverage
        addMargin(bob, quote / 2, 0, address(0));

        (orders[0], signatures[0], orderHashes[0]) = placeOrder(0, aliceKey, size, price, false);
        (orders[1], signatures[1], orderHashes[1]) = placeOrder(0, bobKey, -size, price, false);

        // assert reserved margin
        uint marginRequired = quote / 5 + quote * uint(takerFee) / 1e6;
        assertEq(marginAccount.reservedMargin(alice), marginRequired);
        assertEq(marginAccount.reservedMargin(bob), marginRequired);

        vm.expectRevert("OB_filled_amount_higher_than_order_base");
        orderBook.executeMatchedOrders(orders, signatures, size + 1);

        vm.expectEmit(true, true, false, true, address(orderBook));
        emit OrdersMatched(orderHashes[0], orderHashes[1], uint(size), uint(price), stdMath.abs(2 * size), address(this), block.timestamp);
        orderBook.executeMatchedOrders(orders, signatures, size);

        IOrderBook.Order memory order;
        int filledAmount;
        OrderBook.OrderStatus status;
        (order, temp[0] /** block placed */, filledAmount, temp[1] /** reservedMargin */, status) = orderBook.orderInfo(orderHashes[0]);
        // assert that order, blockPlaced, reservedMargin are deleted
        assertEq(abi.encode(order), abi.encode(IOrderBook.Order(0, address(0), 0, 0, 0, false)));
        assertEq(temp[0], 0);
        assertEq(filledAmount, size);
        assertEq(temp[1], 0);
        assertEq(uint(status), 2); // filled

        (order, temp[0] /** block placed */, filledAmount, temp[1] /** reservedMargin */, status) = orderBook.orderInfo(orderHashes[1]);
        // assert that order, blockPlaced, reservedMargin are deleted
        assertEq(abi.encode(order), abi.encode(IOrderBook.Order(0, address(0), 0, 0, 0, false)));
        assertEq(temp[0], 0);
        assertEq(filledAmount, -size);
        assertEq(temp[1], 0);
        assertEq(uint(status), 2); // filled
        // all margin is freed
        assertEq(marginAccount.reservedMargin(alice), 0);
        assertEq(marginAccount.reservedMargin(bob), 0);

        vm.expectRevert("OB_invalid_order");
        orderBook.executeMatchedOrders(orders, signatures, size);

        assertPositions(alice, size, quote, 0, price);
        assertPositions(bob, -size, quote, 0, price);
    }

    function testLiquidateAndExecuteOrder(uint64 price, uint120 size_) public {
        vm.assume(price > 10 && size_ != 0);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_) + amm.minSizeRequirement()); // to avoid min size error

        // add weth margin
        temp[0] = clearingHouse.getRequiredMargin(size, price) * 1e18 / uint(defaultWethPrice) + 1e10; // required weth margin in 1e18, add 1e10 for any precision loss
        addMargin(alice, temp[0], 1, address(weth));
        addMargin(bob, temp[0], 1, address(weth));
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, true, false, size, false);

        // make alice and bob in liquidatin zone
        oracle.setUnderlyingPrice(address(weth), defaultWethPrice / 10);
        assertFalse(clearingHouse.isAboveMaintenanceMargin(alice));
        assertFalse(clearingHouse.isAboveMaintenanceMargin(bob));

        address charlie;
        (charlie, temp[3] /** charlieKey */) = makeAddrAndKey("charlie");
        addMargin(charlie, stdMath.abs(size) * price / 1e18, 0, address(0));
        (IOrderBook.Order memory order, bytes memory signature, bytes32 orderHash) = placeOrder(0, temp[3], size, price, false);

        // liquidate alice
        uint toLiquidate;
        {
            vm.roll(block.number + 1); // to avoid AMM.liquidation_not_allowed_after_trade
            (,,,uint liquidationThreshold) = amm.positions(alice);
            toLiquidate = Math.min(stdMath.abs(size), liquidationThreshold);
        }

        vm.expectEmit(true, true, false, true, address(orderBook));
        emit LiquidationOrderMatched(address(alice), orderHash, signature, toLiquidate, price, stdMath.abs(2 * size), address(this), block.timestamp);
        orderBook.liquidateAndExecuteOrder(alice, order, signature, toLiquidate);

        {
            (,,int filledAmount, uint reservedMargin, OrderBook.OrderStatus status) = orderBook.orderInfo(orderHash);
            assertEq(uint(status), 1);
            assertEq(filledAmount, int(toLiquidate));
            temp[1] = stdMath.abs(size) * price / 1e18; // quote
            temp[0] = temp[1] / 5 + temp[1] * uint(takerFee) / 1e6; // margin required
            assertEq(marginAccount.reservedMargin(charlie), temp[0] - temp[0] * toLiquidate / stdMath.abs(size));
            assertEq(reservedMargin, temp[0] - temp[0] * toLiquidate / stdMath.abs(size));
        }
        {
            uint liquidationPenalty = toLiquidate * price * liquidationPenalty / 1e24;
            assertEq(marginAccount.margin(0, alice), -int(calculateTakerFee(size, price) + liquidationPenalty));
            // feeSink husd balance = orderMaching fee + liquidationPenalty + tradeFee in liquidation
            assertEq(husd.balanceOf(feeSink), 2 * calculateTakerFee(size, price) + liquidationPenalty + calculateMakerFee(int(toLiquidate), price));
            // marginAccount husd balance = sum(husd margin of all accounts)
            assertEq(
                husd.balanceOf(address(marginAccount)),
                uint(marginAccount.margin(0, charlie)) // charlie margin
                - liquidationPenalty - calculateTakerFee(size, price) // alice margin
                - calculateTakerFee(size, price) // bob margin
            );
        }

        // liquidate bob
        address peter;
        {
            (peter, temp[3] /** peterKey */) = makeAddrAndKey("peter");
            addMargin(peter, stdMath.abs(size) * price / 1e18, 0, address(0));
            (order, signature, orderHash) = placeOrder(0, temp[3], -size, price, false);
        }
        {
            vm.expectEmit(true, false, false, true, address(orderBook));
            emit LiquidationOrderMatched(address(bob), orderHash, signature, toLiquidate, price, stdMath.abs(2 * size), address(this), block.timestamp);
            orderBook.liquidateAndExecuteOrder(bob, order, signature, toLiquidate);
        }
        {
            (,,int filledAmount, uint reservedMargin, OrderBook.OrderStatus status) = orderBook.orderInfo(orderHash);
            assertEq(uint(status), 1);
            assertEq(filledAmount, -int(toLiquidate));
            assertEq(marginAccount.reservedMargin(peter), temp[0] - temp[0] * toLiquidate / stdMath.abs(size));
            assertEq(reservedMargin, temp[0] - temp[0] * toLiquidate / stdMath.abs(size));
        }
        {
            uint liquidationPenalty = toLiquidate * price * liquidationPenalty / 1e24;
            assertEq(marginAccount.margin(0, bob), -int(calculateTakerFee(size, price) + liquidationPenalty));
            // feeSink husd balance = orderMaching fee + 2 * (liquidationPenalty + tradeFee in liquidation)
            assertEq(husd.balanceOf(feeSink), 2 * (calculateTakerFee(size, price) + liquidationPenalty + calculateMakerFee(int(toLiquidate), price)));
            // marginAccount husd balance = sum(husd margin of all accounts)
            assertEq(
                husd.balanceOf(address(marginAccount)),
                2 * uint(marginAccount.margin(0, charlie)) // charlie + peter margin
                - 2 * (liquidationPenalty + calculateTakerFee(size, price)) // alice + bob margin
            );
        }
    }

    function testOrderCancellationWhenNotEnoughMargin(uint64 price, uint120 size_) public {
        vm.assume(price > 10);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_) + amm.minSizeRequirement()); // to avoid min size error

        // alice opens position
        // add weth margin scaled to 18 decimals
        temp[0] =  uint(size) * price / uint(defaultWethPrice); // 1x leverage
        addMargin(alice, temp[0], 1, address(weth));
        addMargin(bob, temp[0], 1, address(weth));
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, true, false, size, false);

        int quote = size * int(uint(price)) / 1e18;
        int utilizedMargin = quote / MAX_LEVERAGE; // 5x max leverage

        // alice places 2 open orders
        (,,bytes32 orderHash1) = placeOrder(0, aliceKey, size + 1, price, false);
        uint reservedMarginForOrder1 = marginAccount.reservedMargin(alice);
        (,,bytes32 orderHash2) = placeOrder(0, aliceKey, size + 2, price, false);
        uint totalReservedMargin = marginAccount.reservedMargin(alice);

        // collateral price decreases such that avaialble margin < 0
        oracle.setUnderlyingPrice(address(weth), defaultWethPrice / 2);
        assertTrue(marginAccount.getAvailableMargin(alice) < 0);
        assertAvailableMargin(alice, 0, int(totalReservedMargin), utilizedMargin);

        // other users cannot cancel order
        vm.prank(bob);
        vm.expectRevert('OB_invalid_sender');
        orderBook.cancelOrder(orderHash1);

        // validator can cancel order1
        orderBook.cancelOrder(orderHash1);
        {
            (IOrderBook.Order memory order, uint blockPlaced, int filledAmount, uint reservedMargin, OrderBook.OrderStatus status) = orderBook.orderInfo(orderHash1);
            // assert that order, blockPlaced, reservedMargin are deleted
            assertEq(abi.encode(order), abi.encode(IOrderBook.Order(0, address(0), 0, 0, 0, false)));
            assertEq(blockPlaced, 0);
            assertEq(filledAmount, 0);
            assertEq(reservedMargin, 0);
            assertEq(uint(status), 3);
            assertEq(marginAccount.reservedMargin(alice), totalReservedMargin - reservedMarginForOrder1);
        }

        {
            // alice avalable margin is > 0
            assertTrue(marginAccount.getAvailableMargin(alice) >= 0);
            assertAvailableMargin(alice, 0, int(totalReservedMargin - reservedMarginForOrder1), utilizedMargin);
        }

        vm.expectRevert('OB_available_margin_not_negative');
        orderBook.cancelOrder(orderHash2);

        // other users cannot cancel order
        vm.prank(bob);
        vm.expectRevert('OB_invalid_sender');
        orderBook.cancelOrder(orderHash2);

        // alice can still cancel the order
        vm.startPrank(alice);
        orderBook.cancelOrder(orderHash2);
        assertEq(marginAccount.reservedMargin(alice), 0);
        // cannot cancel already cancelled order
        vm.expectRevert('OB_Order_does_not_exist');
        orderBook.cancelOrder(orderHash2);
        vm.stopPrank();
    }

    function testCannotExecuteMatchedOrders(uint120 price, uint120 size_) public {
        vm.assume(price != 0);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_) + amm.minSizeRequirement()); // to avoid min size error

        IOrderBook.Order[2] memory orders;
        bytes[2] memory signatures;
        bytes32[2] memory ordersHash;

        uint quote = stdMath.abs(size) * price / 1e18;
        addMargin(alice, quote / 2, 0, address(0)); // 2x leverage
        addMargin(bob, quote / 2, 0, address(0));

        (orders[0], signatures[0], ordersHash[0]) = placeOrder(0, aliceKey, size, price, false);
        (orders[1], signatures[1], ordersHash[1]) = placeOrder(0, bobKey, -size, price, false);

        // different amms
        orders[0].ammIndex = 1;
        vm.expectRevert("OB_orders_for_different_amms");
        orderBook.executeMatchedOrders(orders, signatures, size);
        orders[0].ammIndex = 0;

        vm.expectRevert("OB_order_0_is_not_long");
        orderBook.executeMatchedOrders([orders[1], orders[0]], signatures, size);
        vm.expectRevert("OB_order_1_is_not_short");
        orderBook.executeMatchedOrders([orders[0], orders[0]], signatures, size);
        vm.expectRevert("OB_fill_amount_0");
        orderBook.executeMatchedOrders(orders, signatures, 0);

        // reduce long order price
        (orders[0], signatures[0], ordersHash[0]) = placeOrder(0, aliceKey, size, price - 1, false);
        vm.expectRevert("OB_orders_do_not_match");
        orderBook.executeMatchedOrders(orders, signatures, size);
    }
}
