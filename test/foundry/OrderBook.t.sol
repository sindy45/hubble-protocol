// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "./Utils.sol";

contract OrderBookTests is Utils {
    uint constant public margin = 2000 * 1e6;

    event OrderPlaced(address indexed trader, bytes32 indexed orderHash, IOrderBook.Order order, bytes signature);
    event OrderCancelled(address indexed trader, bytes32 orderHash);
    event OrdersMatched(bytes32 indexed orderHash0, bytes32 indexed orderHash1, uint256 fillAmount, uint price, uint openInterestNotional, address relayer);
    event LiquidationOrderMatched(address indexed trader, bytes32 indexed orderHash, bytes signature, uint256 fillAmount, uint price, uint openInterestNotional, address relayer);
    event OrderMatchingError(bytes32 indexed orderHash, string err);
    event LiquidationError(address indexed trader, bytes32 orderHash, string err, uint256 toLiquidate);

    function setUp() public {
        setupContracts();
        vm.prank(governance);
        orderBook.setValidatorStatus(address(this), true);
    }

    function testPlaceOrder(uint128 traderKey, int size, uint price) public {
        vm.assume(traderKey != 0);
        (address trader, IOrderBook.Order memory order, bytes memory signature, bytes32 orderHash) = prepareOrder(0, traderKey, size, price);

        vm.expectRevert("OB_sender_is_not_trader");
        orderBook.placeOrder(order, signature);

        vm.startPrank(trader);
        vm.expectEmit(true, true, false, true, address(orderBook));
        emit OrderPlaced(trader, orderHash, order, signature);
        orderBook.placeOrder(order, signature);

        vm.expectRevert("OB_Order_already_exists");
        orderBook.placeOrder(order, signature);

        (address _trader ,uint blockPlaced, int filledAmount, OrderBook.OrderStatus status) = orderBook.orderInfo(orderHash);
        assertEq(trader, _trader);
        assertEq(uint(status), 1); // placed
        assertEq(blockPlaced, block.number);
        assertEq(filledAmount, 0);

        order.salt += 1;
        vm.expectRevert("OB_SINT"); // Signature and order doesn't match
        orderBook.placeOrder(order, signature);

        order.salt -= 1;
        orderBook.cancelOrder(orderHash);
        (,,filledAmount, status) = orderBook.orderInfo(orderHash);
        assertEq(uint(status), 3); // cancelled
        vm.stopPrank();
    }

    // used uint32 for price here to avoid many rejections in vm.assume
    function testExecuteMatchedOrders(uint32 price, uint120 size_) public {
        {
            uint oraclePrice = uint(oracle.getUnderlyingPrice(address(wavax)));
            uint maxOracleSpreadRatio = amm.maxOracleSpreadRatio();
            uint upperLimit = oraclePrice * (1e6 + maxOracleSpreadRatio) / 1e6 - 2;
            uint lowerLimit = oraclePrice * (1e6 - maxOracleSpreadRatio) / 1e6 + 2;
            vm.assume(price < upperLimit && price > lowerLimit);
        }

        IOrderBook.Order[2] memory orders;
        bytes[2] memory signatures;
        bytes32[2] memory ordersHash;

        int size = int(uint(size_) + amm.minSizeRequirement()); // to avoid min size error
        (orders[0], signatures[0], ordersHash[0]) = placeOrder(0, aliceKey, size, price);
        (orders[1], signatures[1], ordersHash[1]) = placeOrder(0, bobKey, -size, price);

        vm.expectEmit(true, false, false, true, address(orderBook));
        emit OrderMatchingError(ordersHash[0], "CH: Below Minimum Allowable Margin");
        orderBook.executeMatchedOrders(orders, signatures, size);

        uint quote = stdMath.abs(size) * price / 1e18;
        addMargin(alice, quote / 2); // 2x leverage
        addMargin(bob, quote / 2);

        vm.expectEmit(true, true, false, true, address(orderBook));
        emit OrdersMatched(ordersHash[0], ordersHash[1], uint(size), uint(price), stdMath.abs(2 * size), address(this));
        orderBook.executeMatchedOrders(orders, signatures, size);

        (,,int filledAmount, OrderBook.OrderStatus status) = orderBook.orderInfo(ordersHash[0]);
        assertEq(uint(status), 2); // filled
        assertEq(filledAmount, size);
        (,,filledAmount, status) = orderBook.orderInfo(ordersHash[1]);
        assertEq(uint(status), 2); // filled
        assertEq(filledAmount, -size);

        vm.expectRevert("OB_invalid_order");
        orderBook.executeMatchedOrders(orders, signatures, size);

        assertPositions(alice, size, quote, 0, price);
        assertPositions(bob, -size, quote, 0, price);
        // @todo assert fee transfer
    }

    function testLiquidateAndExecuteOrder(uint120 size_) public {
        vm.assume(size_ != 0);
        int size = int(uint(size_) + amm.minSizeRequirement()); // to avoid min size error
        uint price = 20 * 1e6;
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, true);

        // make alice and bob in liquidatin zone
        vm.prank(governance);
        marginAccount.setPortfolioManager(address(this));
        marginAccount.removeMarginFor(alice, 0, uint(marginAccount.margin(0, alice)));
        marginAccount.removeMarginFor(bob, 0, uint(marginAccount.margin(0, bob)));
        assertFalse(clearingHouse.isAboveMaintenanceMargin(alice));
        assertFalse(clearingHouse.isAboveMaintenanceMargin(bob));

        (address charlie, uint charlieKey) = makeAddrAndKey("charlie");
        addMargin(charlie, stdMath.abs(size) * price / 1e18);
        (IOrderBook.Order memory order, bytes memory signature, bytes32 orderHash) = placeOrder(0, charlieKey, size, price);

        uint toLiquidate;
        {
            {
                // liquidate alice
                vm.roll(block.number + 1); // to avoid AMM.liquidation_not_allowed_after_trade
                (,,,uint liquidationThreshold) = amm.positions(alice);
                toLiquidate = Math.min(stdMath.abs(size), liquidationThreshold);
            }

            uint feeSinkBalanceBefore = husd.balanceOf(feeSink);
            vm.expectEmit(true, true, false, true, address(orderBook));
            emit LiquidationOrderMatched(address(alice), orderHash, signature, toLiquidate, price, stdMath.abs(2 * size), address(this));
            orderBook.liquidateAndExecuteOrder(alice, order, signature, toLiquidate);

            {
                (,,int filledAmount, OrderBook.OrderStatus status) = orderBook.orderInfo(orderHash);
                assertEq(uint(status), 1);
                assertEq(filledAmount, int(toLiquidate));
            }
            {
                uint liquidationPenalty = toLiquidate * price * liquidationPenalty / 1e24;
                uint tradeFee = toLiquidate * price * uint(takerFee) / 1e24;
                assertEq(husd.balanceOf(feeSink), feeSinkBalanceBefore + liquidationPenalty + tradeFee);
                assertEq(husd.balanceOf(address(marginAccount)), uint(marginAccount.margin(0, charlie)) - liquidationPenalty);
            }
        }

        {
            // @todo allow multiple liquidations in a single block
            vm.roll(block.number + 1); // to avoid AMM.liquidation_not_allowed_after_trade
            // liquidate bob
            (address peter, uint peterKey) = makeAddrAndKey("peter");
            addMargin(peter, stdMath.abs(size) * price / 1e18);
            (order, signature, orderHash) = placeOrder(0, peterKey, -size, price);
        }
        {
            vm.expectEmit(true, false, false, true, address(orderBook));
            emit LiquidationOrderMatched(address(bob), orderHash, signature, toLiquidate, price, stdMath.abs(2 * size), address(this));
            orderBook.liquidateAndExecuteOrder(bob, order, signature, toLiquidate);
        }
        {
            (,,int filledAmount, OrderBook.OrderStatus status) = orderBook.orderInfo(orderHash);
            assertEq(uint(status), 1);
            assertEq(filledAmount, -int(toLiquidate));
        }
    }

    function testNegativeMakerFee(int120 size_) public {
        vm.assume(size_ != 0);
        int size;
        if (size_ > 0) {
            size = size_ + int(amm.minSizeRequirement());
        } else {
            size = size_ - int(amm.minSizeRequirement());
        }

        int _takerFee = 0.1 * 1e4; // 10 bps
        int _makerFee = -0.01 * 1e4; // -1 bps
        uint _referralShare = 5 * 1e4; // referralShare = 5% of tradeFee
        uint _feeDiscount = 10 * 1e4; // feeDiscount = 10% of tradeFee

        vm.prank(governance);
        clearingHouse.setParams(
            0.1 * 1e6, // 10% maintenance margin, 10x
            0.2 * 1e6, // 20% minimum allowable margin, 5x
            _takerFee,
            _makerFee,
            _referralShare,
            _feeDiscount,
            0.05 * 1e6 // liquidationPenalty = 5%
        );

        // create referral code
        string memory referralCode = 'testReferral';
        hubbleReferral.createReferralCode(referralCode);
        // set referral code
        vm.prank(alice);
        hubbleReferral.setReferralCode(referralCode);
        vm.prank(bob);
        hubbleReferral.setReferralCode(referralCode);

        assertEq(husd.balanceOf(alice), 0);
        assertEq(husd.balanceOf(bob), 0);
        assertEq(husd.balanceOf(feeSink), 0);
        assertEq(uint(marginAccount.margin(0, address(this))), 0);

        uint price = 20 * 1e6;
        // alice - maker, bob - taker
        uint _margin = placeAndExecuteOrder(0, aliceKey, bobKey, size, price, false);

        uint quote = stdMath.abs(size) * price / 1e18;
        uint makerFeePayed = quote * stdMath.abs(_makerFee) / 1e6;
        uint takerFeeCharged = quote * uint(_takerFee) / 1e6;
        uint referralShare = takerFeeCharged * _referralShare / 1e6;
        takerFeeCharged = takerFeeCharged - takerFeeCharged * _feeDiscount / 1e6; // trade fee discount

        uint aliceMargin = uint(marginAccount.margin(0, alice));
        uint bobMargin = uint(marginAccount.margin(0, bob));
        assertEq(aliceMargin, _margin + makerFeePayed);
        assertEq(bobMargin, _margin - takerFeeCharged);
        assertEq(husd.balanceOf(feeSink), takerFeeCharged - makerFeePayed - referralShare);
        assertEq(uint(marginAccount.margin(0, address(this))), referralShare);
        assertEq(husd.balanceOf(address(marginAccount)), aliceMargin + bobMargin + referralShare);
    }

    function testPositiveMakerFee(int120 size_) public {
        vm.assume(size_ != 0);
        int size;
        if (size_ > 0) {
            size = size_ + int(amm.minSizeRequirement());
        } else {
            size = size_ - int(amm.minSizeRequirement());
        }

        int _takerFee = 0.05 * 1e4; // 5 bps
        int _makerFee = 0.05 * 1e4; // 5 bps
        uint _referralShare = 5 * 1e4; // referralShare = 5% of tradeFee
        uint _feeDiscount = 10 * 1e4; // feeDiscount = 10% of tradeFee

        vm.prank(governance);
        clearingHouse.setParams(
            0.1 * 1e6, // 10% maintenance margin, 10x
            0.2 * 1e6, // 20% minimum allowable margin, 5x
            _takerFee,
            _makerFee,
            _referralShare,
            _feeDiscount,
            0.05 * 1e6 // liquidationPenalty = 5%
        );

        // create referral code
        string memory referralCode = 'testReferral';
        hubbleReferral.createReferralCode(referralCode);
        // set referral code
        vm.prank(alice);
        hubbleReferral.setReferralCode(referralCode);
        vm.prank(bob);
        hubbleReferral.setReferralCode(referralCode);

        assertEq(husd.balanceOf(alice), 0);
        assertEq(husd.balanceOf(bob), 0);
        assertEq(husd.balanceOf(feeSink), 0);
        assertEq(uint(marginAccount.margin(0, address(this))), 0);

        uint price = 20 * 1e6;
        // alice - maker, bob - taker
        uint _margin = placeAndExecuteOrder(0, aliceKey, bobKey, size, price, false);

        uint quote = stdMath.abs(size) * price / 1e18;
        uint makerFeeCharged = quote * uint(_makerFee) / 1e6;
        uint takerFeeCharged = quote * uint(_takerFee) / 1e6;
        uint referralShare = takerFeeCharged * _referralShare / 1e6;

        takerFeeCharged = takerFeeCharged - takerFeeCharged * _feeDiscount / 1e6; // trade fee discount
        makerFeeCharged = makerFeeCharged - makerFeeCharged * _feeDiscount / 1e6; // trade fee discount

        uint aliceMargin = uint(marginAccount.margin(0, alice));
        uint bobMargin = uint(marginAccount.margin(0, bob));
        assertEq(aliceMargin, _margin - makerFeeCharged);
        assertEq(bobMargin, _margin - takerFeeCharged);
        assertEq(husd.balanceOf(feeSink), takerFeeCharged + makerFeeCharged - 2 * referralShare);
        assertEq(uint(marginAccount.margin(0, address(this))), 2 * referralShare);
        assertEq(husd.balanceOf(address(marginAccount)), aliceMargin + bobMargin + 2 * referralShare);
    }

    function testNegativeMakerFeeSameBlockTrade(int120 size_) public {
        vm.assume(size_ != 0);
        int size;
        if (size_ > 0) {
            size = size_ + int(amm.minSizeRequirement());
        } else {
            size = size_ - int(amm.minSizeRequirement());
        }

        int _takerFee = 0.1 * 1e4; // 10 bps
        int _makerFee = -0.01 * 1e4; // -1 bps
        uint _referralShare = 5 * 1e4; // referralShare = 5% of tradeFee
        uint _feeDiscount = 10 * 1e4; // feeDiscount = 10% of tradeFee

        vm.prank(governance);
        clearingHouse.setParams(
            0.1 * 1e6, // 10% maintenance margin, 10x
            0.2 * 1e6, // 20% minimum allowable margin, 5x
            _takerFee,
            _makerFee,
            _referralShare,
            _feeDiscount,
            0.05 * 1e6 // liquidationPenalty = 5%
        );

        // create referral code
        string memory referralCode = 'testReferral';
        hubbleReferral.createReferralCode(referralCode);
        // set referral code
        vm.prank(alice);
        hubbleReferral.setReferralCode(referralCode);
        vm.prank(bob);
        hubbleReferral.setReferralCode(referralCode);

        assertEq(husd.balanceOf(alice), 0);
        assertEq(husd.balanceOf(bob), 0);
        assertEq(husd.balanceOf(feeSink), 0);
        assertEq(uint(marginAccount.margin(0, address(this))), 0);

        uint price = 20 * 1e6;
        // alice - taker, bob - taker
        uint _margin = placeAndExecuteOrder(0, aliceKey, bobKey, size, price, true);

        uint quote = stdMath.abs(size) * price / 1e18;
        uint takerFeeCharged = quote * uint(_takerFee) / 1e6;
        uint referralShare = takerFeeCharged * _referralShare / 1e6;
        takerFeeCharged = takerFeeCharged - takerFeeCharged * _feeDiscount / 1e6; // trade fee discount

        uint aliceMargin = uint(marginAccount.margin(0, alice));
        uint bobMargin = uint(marginAccount.margin(0, bob));
        assertEq(aliceMargin, _margin - takerFeeCharged);
        assertEq(bobMargin, _margin - takerFeeCharged);
        assertEq(husd.balanceOf(feeSink), 2 * (takerFeeCharged - referralShare));
        assertEq(uint(marginAccount.margin(0, address(this))), 2 * referralShare);
        assertEq(husd.balanceOf(address(marginAccount)), aliceMargin + bobMargin + 2 * referralShare);
    }

    function testLiquidationWithNegativeMakerFee(uint120 size_) public {
        vm.assume(size_ != 0);
        int size = int(uint(size_) + amm.minSizeRequirement()); // to avoid min size error
        uint price = 20 * 1e6;

        takerFee = 0.001 * 1e6; // 10 bps
        makerFee = -0.0001 * 1e6; // -1 bps
        vm.prank(governance);
        clearingHouse.setParams(
            0.1 * 1e6, // 10% maintenance margin, 10x
            0.2 * 1e6, // 20% minimum allowable margin, 5x
            takerFee,
            makerFee,
            0, // referral share
            0, // fee discount
            liquidationPenalty // liquidationPenalty = 5%
        );

        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, true);

        // make alice and bob in liquidatin zone
        vm.prank(governance);
        marginAccount.setPortfolioManager(address(this));
        marginAccount.removeMarginFor(alice, 0, uint(marginAccount.margin(0, alice)));
        marginAccount.removeMarginFor(bob, 0, uint(marginAccount.margin(0, bob)));
        assertFalse(clearingHouse.isAboveMaintenanceMargin(alice));
        assertFalse(clearingHouse.isAboveMaintenanceMargin(bob));

        address charlie;
        (charlie, temp[0] /**charlieKey */) = makeAddrAndKey("charlie");
        uint charlieMargin = stdMath.abs(size) * price / 1e18;
        addMargin(charlie, charlieMargin);
        (IOrderBook.Order memory order, bytes memory signature, bytes32 orderHash) = placeOrder(0, temp[0], size, price);

        uint toLiquidate;
        {
            {
                // liquidate alice
                vm.roll(block.number + 1); // to avoid AMM.liquidation_not_allowed_after_trade
                (,,, temp[1] /** liquidationThreshold */) = amm.positions(alice);
                toLiquidate = Math.min(stdMath.abs(size), temp[1]);
            }

            uint feeSinkBalanceBefore = husd.balanceOf(feeSink);
            vm.expectEmit(true, true, false, true, address(orderBook));
            emit LiquidationOrderMatched(address(alice), orderHash, signature, toLiquidate, price, stdMath.abs(2 * size), address(this));
            orderBook.liquidateAndExecuteOrder(alice, order, signature, toLiquidate);

            {
                (,,int filledAmount, OrderBook.OrderStatus status) = orderBook.orderInfo(orderHash);
                assertEq(uint(status), 1);
                assertEq(filledAmount, int(toLiquidate));
            }
            {
                uint liquidationPenalty = toLiquidate * price * liquidationPenalty / 1e24;
                uint makerFeePayed = toLiquidate * price * uint(-makerFee) / 1e24;
                assertEq(husd.balanceOf(feeSink), feeSinkBalanceBefore + liquidationPenalty - makerFeePayed);
                // makerFeePayed is added to charlie margin
                assertEq(uint(marginAccount.margin(0, charlie)), charlieMargin + makerFeePayed);
                assertEq(husd.balanceOf(address(marginAccount)), charlieMargin - liquidationPenalty + makerFeePayed);
            }
        }
    }
}
