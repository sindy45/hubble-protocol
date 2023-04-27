// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "./Utils.sol";

contract ClearingHouseTests is Utils {
    RestrictedErc20 public weth;
    int public constant defaultWethPrice = 1000 * 1e6;

    event LiquidationOrderMatched(address indexed trader, bytes32 indexed orderHash, bytes signature, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);
    event OrderMatchingError(bytes32 indexed orderHash, string err);

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

    function testReduceOnly(uint64 price, uint120 size_) public {
        vm.assume(price > 10);
        oracle.setUnderlyingPrice(address(wavax), int(uint(price)));
        int size = int(uint(size_) + 2 * amm.minSizeRequirement()); // to avoid min size error

        // alice longs, bob shorts, fillAmount = size / 2
        uint requiredMargin = clearingHouse.getRequiredMargin(size, price);
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, false, true, size / 2, false);
        assertApproxEqAbs(marginAccount.reservedMargin(alice), requiredMargin / 2, 10 /** maxDelta */);
        assertApproxEqAbs(marginAccount.reservedMargin(bob), requiredMargin / 2, 10);

        IOrderBook.Order[2] memory orders;
        bytes[2] memory signatures;
        bytes32[] memory orderHashes = new bytes32[](2);
        addMargin(alice, requiredMargin * 10, 0, address(0));
        addMargin(bob, requiredMargin * 10, 0, address(0));

        // position cannot increase for a reduce-only order
        // long order increase fail, alice longs more
        (orders[0], signatures[0], orderHashes[0]) = placeOrder(0, aliceKey, size, price - 1, true /** reduceOnly */);
        (orders[1], signatures[1], orderHashes[1]) = placeOrder(0, bobKey, -size, price - 1, false /** reduceOnly */);
        vm.expectEmit(true, false, false, true, address(orderBook));
        emit OrderMatchingError(orderHashes[0], "CH: reduceOnly order can only reduce position");
        orderBook.executeMatchedOrders(orders, signatures, size);
        // short order increase fail, bob shorts more
        (orders[0], signatures[0], orderHashes[0]) = placeOrder(0, aliceKey, size, price - 1, false /** reduceOnly */);
        (orders[1], signatures[1], orderHashes[1]) = placeOrder(0, bobKey, -size, price - 1, true /** reduceOnly */);
        vm.expectEmit(true, false, false, true, address(orderBook));
        emit OrderMatchingError(orderHashes[1], "CH: reduceOnly order can only reduce position");
        orderBook.executeMatchedOrders(orders, signatures, size);

        // position cannot reverse for a reduce-only order
        // long order reverse fail, bob longs
        (orders[0], signatures[0], orderHashes[0]) = placeOrder(0, bobKey, size, price - 1, true /** reduceOnly */);
        (orders[1], signatures[1], orderHashes[1]) = placeOrder(0, aliceKey, -size, price - 1, false /** reduceOnly */);
        vm.expectEmit(true, false, false, true, address(orderBook));
        emit OrderMatchingError(orderHashes[0], "CH: reduceOnly order can only reduce position");
        orderBook.executeMatchedOrders(orders, signatures, size);
        // short order reverse fail, alice shorts
        (orders[0], signatures[0], orderHashes[0]) = placeOrder(0, bobKey, size, price - 1, false /** reduceOnly */);
        (orders[1], signatures[1], orderHashes[1]) = placeOrder(0, aliceKey, -size, price - 1, true /** reduceOnly */);
        vm.expectEmit(true, false, false, true, address(orderBook));
        emit OrderMatchingError(orderHashes[1], "CH: reduceOnly order can only reduce position");
        orderBook.executeMatchedOrders(orders, signatures, size);

        // no margin is reserved for a reduce-only order
        uint[2] memory reservedMargin; // 0 - alice, 1 - bob
        reservedMargin[1] = marginAccount.reservedMargin(bob);
        (orders[0], signatures[0], orderHashes[0]) = placeOrder(0, bobKey, size, price - 2, true /** reduceOnly */);
        assertEq(marginAccount.reservedMargin(bob), reservedMargin[1]); // no new margin reserved
        reservedMargin[0] = marginAccount.reservedMargin(alice);
        (orders[1], signatures[1], orderHashes[1]) = placeOrder(0, aliceKey, -size, price - 2, true /** reduceOnly */);
        assertEq(marginAccount.reservedMargin(alice), reservedMargin[0]); // no new margin reserved

        // position can decrease for a reduce-only order
        orderBook.executeMatchedOrders(orders, signatures, size / 2);
        assertEq(marginAccount.reservedMargin(alice), reservedMargin[0]); // no new margin released
        assertEq(marginAccount.reservedMargin(bob), reservedMargin[1]); // no new margin released
        assertPositions(alice, 0, 0, 0, 0);
        assertPositions(bob, 0, 0, 0, 0);
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
        uint margin = placeAndExecuteOrder(0, aliceKey, bobKey, size, price, false, true, size, false);

        uint quote = stdMath.abs(size) * price / 1e18;
        uint makerFeePayed = quote * stdMath.abs(_makerFee) / 1e6;
        uint takerFeeCharged = quote * uint(_takerFee) / 1e6;
        uint referralShare = takerFeeCharged * _referralShare / 1e6;
        takerFeeCharged = takerFeeCharged - takerFeeCharged * _feeDiscount / 1e6; // trade fee discount

        uint aliceMargin = uint(marginAccount.margin(0, alice));
        uint bobMargin = uint(marginAccount.margin(0, bob));
        assertEq(aliceMargin, margin + makerFeePayed);
        assertEq(bobMargin, margin - takerFeeCharged);
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
        uint margin = placeAndExecuteOrder(0, aliceKey, bobKey, size, price, false, true, size, false);

        uint quote = stdMath.abs(size) * price / 1e18;
        uint makerFeeCharged = quote * uint(_makerFee) / 1e6;
        uint takerFeeCharged = quote * uint(_takerFee) / 1e6;
        uint referralShare = takerFeeCharged * _referralShare / 1e6;

        takerFeeCharged = takerFeeCharged - takerFeeCharged * _feeDiscount / 1e6; // trade fee discount
        makerFeeCharged = makerFeeCharged - makerFeeCharged * _feeDiscount / 1e6; // trade fee discount

        uint aliceMargin = uint(marginAccount.margin(0, alice));
        uint bobMargin = uint(marginAccount.margin(0, bob));
        assertEq(aliceMargin, margin - makerFeeCharged);
        assertEq(bobMargin, margin - takerFeeCharged);
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
        uint margin = placeAndExecuteOrder(0, aliceKey, bobKey, size, price, true, true, size, false);

        uint quote = stdMath.abs(size) * price / 1e18;
        uint takerFeeCharged = quote * uint(_takerFee) / 1e6;
        uint referralShare = takerFeeCharged * _referralShare / 1e6;
        takerFeeCharged = takerFeeCharged - takerFeeCharged * _feeDiscount / 1e6; // trade fee discount

        uint aliceMargin = uint(marginAccount.margin(0, alice));
        uint bobMargin = uint(marginAccount.margin(0, bob));
        assertEq(aliceMargin, margin - takerFeeCharged);
        assertEq(bobMargin, margin - takerFeeCharged);
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

        // add weth margin
        temp[0] = clearingHouse.getRequiredMargin(size, price) * 1e18 / uint(defaultWethPrice) + 1e12; // required weth margin in 1e18, add 1e12 for any precision loss
        addMargin(alice, temp[0], 1, address(weth));
        addMargin(bob, temp[0], 1, address(weth));
        placeAndExecuteOrder(0, aliceKey, bobKey, size, price, true, false, size, false);

        // make alice and bob in liquidatin zone
        oracle.setUnderlyingPrice(address(weth), defaultWethPrice / 2);
        assertFalse(clearingHouse.isAboveMaintenanceMargin(alice));
        assertFalse(clearingHouse.isAboveMaintenanceMargin(bob));

        address charlie;
        (charlie, temp[0] /**charlieKey */) = makeAddrAndKey("charlie");
        uint charlieMargin = stdMath.abs(size) * price / 1e18;
        addMargin(charlie, charlieMargin, 0, address(0));
        (IOrderBook.Order memory order, bytes memory signature, bytes32 orderHash) = placeOrder(0, temp[0], size, price, false);

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
            // feeSink husd balance = orderMaching fee + liquidationPenalty - makerFee in liquidation
            assertEq(husd.balanceOf(feeSink), 2 * calculateTakerFee(size, price) + liquidationPenalty - calculateMakerFee(int(toLiquidate), price));
            // makerFee is added to charlie margin
            assertEq(uint(marginAccount.margin(0, charlie)), charlieMargin + calculateMakerFee(int(toLiquidate), price));
            // marginAccount husd balance = sum(husd margin of all accounts)
            assertEq(
                husd.balanceOf(address(marginAccount)),
                uint(marginAccount.margin(0, charlie)) // charlie margin
                - liquidationPenalty - calculateTakerFee(size, price) // alice margin
                - calculateTakerFee(size, price) // bob margin
            );
        }
    }
}
