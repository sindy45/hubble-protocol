const utils = require('./utils')
const { BigNumber } = require('ethers')
const { expect } = require('chai');

const {
    constants: { _1e6, _1e18, ZERO },
    setupContracts,
    addMargin,
    filterEvent
} = utils

describe('Order Book', function () {
    before(async function () {
        signers = await ethers.getSigners()
        ;([, alice, bob] = signers)
        ;({ orderBook, usdc, oracle, weth } = await setupContracts({mockOrderBook: false}))

        await addMargin(alice, _1e6.mul(4000))
        await addMargin(bob, _1e6.mul(4000))
        const tx = await orderBook.setValidatorStatus(signers[0].address, true)
        timestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;
    })

    it('verify signer', async function() {
        domain = {
            name: 'Hubble',
            version: '2.0',
            chainId: (await ethers.provider.getNetwork()).chainId,
            verifyingContract: orderBook.address
        }

        orderType = {
            Order: [
                // field ordering must be the same as LIMIT_ORDER_TYPEHASH
                { name: "ammIndex", type: "uint256" },
                { name: "trader", type: "address" },
                { name: "baseAssetQuantity", type: "int256" },
                { name: "price", type: "uint256" },
                { name: "salt", type: "uint256" },
                { name: "expiry", type: "uint256" },
            ]
        }
        shortOrder = {
            ammIndex: ZERO,
            trader: alice.address,
            baseAssetQuantity: ethers.utils.parseEther('-5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now()),
            expiry: BigNumber.from(timestamp + 3600)
        }

        order1Hash = await orderBook.getOrderHash(shortOrder)
        signature1 = await alice._signTypedData(domain, orderType, shortOrder)
        const signer = (await orderBook.verifySigner(shortOrder, signature1))[0]
        expect(signer).to.eq(alice.address)
    })

    it('place an order', async function() {
        await expect(orderBook.placeOrder(shortOrder, signature1)).to.revertedWith('OB_sender_is_not_trader')
        const tx = await orderBook.connect(alice).placeOrder(shortOrder, signature1)
        await expect(tx).to.emit(orderBook, "OrderPlaced").withArgs(
            shortOrder.trader,
            order1Hash,
            Object.values(shortOrder),
            signature1
        )
        await expect(orderBook.connect(alice).placeOrder(shortOrder, signature1)).to.revertedWith('OB_Order_already_exists')
        expect((await orderBook.orderInfo(order1Hash)).status).to.eq(1) // placed
    })

    it('matches orders with same price and opposite base asset quantity', async function() {
      // long order with same price and baseAssetQuantity
        longOrder = {
            ammIndex: ZERO,
            trader: bob.address,
            baseAssetQuantity: ethers.utils.parseEther('5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now()),
            expiry: BigNumber.from(timestamp + 3600)
        }
        signature2 = await bob._signTypedData(domain, orderType, longOrder)
        await orderBook.connect(bob).placeOrder(longOrder, signature2)

        const tx = await orderBook.executeMatchedOrders(
            [ longOrder, shortOrder ],
            [ signature2, signature1 ],
            longOrder.baseAssetQuantity
        )

        order2Hash = await orderBook.getOrderHash(longOrder)

        await expect(tx).to.emit(orderBook, 'OrdersMatched').withArgs(
            order2Hash,
            order1Hash,
            longOrder.baseAssetQuantity,
            longOrder.price,
            longOrder.baseAssetQuantity.mul(2),
            governance
        )

        expect((await orderBook.orderInfo(order1Hash)).status).to.eq(2) // filled
        expect((await orderBook.orderInfo(order2Hash)).status).to.eq(2) // filled
        await expect(orderBook.executeMatchedOrders(
            [ longOrder, shortOrder ],
            [ signature2, signature1 ],
            longOrder.baseAssetQuantity
        )).to.revertedWith('OB_invalid_order')
    })

    it('matches multiple long orders with same price and opposite base asset quantity with short orders', async function() {
        longOrder.salt = Date.now()
        const longOrder1 = JSON.parse(JSON.stringify(longOrder))
        longSignature1 = await bob._signTypedData(domain, orderType, longOrder)
        await orderBook.connect(bob).placeOrder(longOrder, longSignature1)

        longOrder.salt = Date.now()
        const longOrder2 = JSON.parse(JSON.stringify(longOrder))
        longSignature2 = await bob._signTypedData(domain, orderType, longOrder)
        await orderBook.connect(bob).placeOrder(longOrder, longSignature2)

        shortOrder.salt = Date.now()
        const shortOrder1 = JSON.parse(JSON.stringify(shortOrder))
        shortSignature1 = await alice._signTypedData(domain, orderType, shortOrder)
        await orderBook.connect(alice).placeOrder(shortOrder, shortSignature1)

        shortOrder.salt = Date.now()
        const shortOrder2 = JSON.parse(JSON.stringify(shortOrder))
        shortSignature2 = await alice._signTypedData(domain, orderType, shortOrder)
        await orderBook.connect(alice).placeOrder(shortOrder, shortSignature2)

        const filter = orderBook.filters
        let events = await orderBook.queryFilter(filter)

        expect(events[events.length - 1].event).to.eq('OrderPlaced')
        expect(events[events.length - 2].event).to.eq('OrderPlaced')
        expect(events[events.length - 3].event).to.eq('OrderPlaced')
        expect(events[events.length - 4].event).to.eq('OrderPlaced')

        // match 1
        let tx = await orderBook.executeMatchedOrders(
            [ longOrder1, shortOrder1 ],
            [ longSignature1, shortSignature1 ],
            longOrder1.baseAssetQuantity
        )
        await expect(tx).to.emit(orderBook, 'OrdersMatched')

        // match 2
        tx = await orderBook.executeMatchedOrders(
            [ longOrder2, shortOrder2 ],
            [ longSignature2, shortSignature2 ],
            longOrder2.baseAssetQuantity
        )
        await expect(tx).to.emit(orderBook, 'OrdersMatched')
    })

    it('liquidateAndExecuteOrder', async function() {
        // force alice in liquidation zone
        const markPrice = _1e6.mul(1180)
        await placeAndExecuteTrade(_1e18.mul(5), markPrice, longOrder.expiry)
        expect(await clearingHouse.isAboveMaintenanceMargin(alice.address)).to.eq(false)
        expect(await clearingHouse.isAboveMaintenanceMargin(bob.address)).to.eq(true)
        const { size } = await amm.positions(alice.address)

        const charlie = signers[7]
        await addMargin(charlie, _1e6.mul(2000))
        const { order, signature } = await placeOrder(size, markPrice, charlie, longOrder.expiry)

        // liquidate
        const toLiquidate = size.mul(25e4).div(1e6).add(1) // 1/4th position liquidated
        await orderBook.liquidateAndExecuteOrder(alice.address, order, signature, toLiquidate.abs())
        const { size: sizeAfterLiquidation } = await amm.positions(alice.address)
        expect(sizeAfterLiquidation).to.eq(size.sub(toLiquidate))
        let position = await amm.positions(charlie.address)
        expect(position.size).to.eq(size.sub(sizeAfterLiquidation))

        const fillAmount = _1e18.div(-10) // 0.1
        await orderBook.liquidateAndExecuteOrder(alice.address, order, signature, fillAmount.abs())
        const { size: sizeAfter2ndLiquidation } = await amm.positions(alice.address)
        expect(sizeAfter2ndLiquidation).to.eq(sizeAfterLiquidation.sub(fillAmount)) // only fill amount liquidated
        position = await amm.positions(charlie.address)
        expect(position.size).to.eq(size.sub(sizeAfter2ndLiquidation))
    })
})

describe('Order Book - Error Handling', function () {
    before(async function () {
        signers = await ethers.getSigners()
        ;([, alice, bob] = signers)
        ;({ orderBook, usdc, oracle, weth, amm } = await setupContracts({mockOrderBook: false}))

        const tx = await orderBook.setValidatorStatus(signers[0].address, true)
        timestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

        // we will deliberately not add any margin so that openPosition fails
    })

    it('alice places order', async function() {
        orderType = {
            Order: [
                // field ordering must be the same as LIMIT_ORDER_TYPEHASH
                { name: "ammIndex", type: "uint256" },
                { name: "trader", type: "address" },
                { name: "baseAssetQuantity", type: "int256" },
                { name: "price", type: "uint256" },
                { name: "salt", type: "uint256" },
                { name: "expiry", type: "uint256" },
            ]
        }

        domain = {
            name: 'Hubble',
            version: '2.0',
            chainId: (await ethers.provider.getNetwork()).chainId,
            verifyingContract: orderBook.address
        }

        shortOrder = {
            ammIndex: ZERO,
            trader: alice.address,
            baseAssetQuantity: ethers.utils.parseEther('-5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now()),
            expiry: BigNumber.from(timestamp + 3600)
        }
        order1Hash = await orderBook.getOrderHash(shortOrder)
        signature1 = await alice._signTypedData(domain, orderType, shortOrder)

        await expect(orderBook.placeOrder(shortOrder, signature1)).to.revertedWith('OB_sender_is_not_trader')
        const tx = await orderBook.connect(alice).placeOrder(shortOrder, signature1)
        await expect(tx).to.emit(orderBook, "OrderPlaced").withArgs(
            shortOrder.trader,
            order1Hash,
            Object.values(shortOrder),
            signature1
        )
        await expect(orderBook.connect(alice).placeOrder(shortOrder, signature1)).to.revertedWith('OB_Order_already_exists')
        expect((await orderBook.orderInfo(order1Hash)).status).to.eq(1) // placed
    })

    it('ch.openPosition fails for long order', async function() {
      // long order with same price and baseAssetQuantity
        longOrder = {
            ammIndex: ZERO,
            trader: bob.address,
            baseAssetQuantity: ethers.utils.parseEther('5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now()),
            expiry: BigNumber.from(timestamp + 3600)
        }
        order2Hash = await orderBook.getOrderHash(longOrder)
        signature2 = await bob._signTypedData(domain, orderType, longOrder)
        await orderBook.connect(bob).placeOrder(longOrder, signature2)

        const tx = await orderBook.executeMatchedOrders(
            [ longOrder, shortOrder ],
            [ signature2, signature1 ],
            longOrder.baseAssetQuantity
        )

        await expect(tx).to.emit(orderBook, 'OrderMatchingError')
        const event = await filterEvent(tx, 'OrderMatchingError')
        expect(event.args.orderHash).to.eq(order2Hash)
        expect(event.args.err).to.eq('CH: Below Minimum Allowable Margin')
        await assertPosSize(0, 0)
    })

    it('ch.openPosition fails for short order', async function() {
        // now bob deposits enough margin so that open position for them doesn't fail
        await addMargin(bob, _1e6.mul(4000))
        const tx = await orderBook.executeMatchedOrders(
            [ longOrder, shortOrder ],
            [ signature2, signature1 ],
            longOrder.baseAssetQuantity
        )

        await expect(tx).to.emit(orderBook, 'OrderMatchingError')
        const event = await filterEvent(tx, 'OrderMatchingError')
        expect(event.args.orderHash).to.eq(order1Hash)
        expect(event.args.err).to.eq('CH: Below Minimum Allowable Margin')
        await assertPosSize(0, 0)
    })

    it('try with another err msg', async function() {
        const badShortOrder = JSON.parse(JSON.stringify(shortOrder))
        badShortOrder.price = ethers.utils.parseUnits('2000', 6)
        // signature1, order2Hash, signature2 are declared locally so they don't affect the vars in global scope
        const signature1 = await alice._signTypedData(domain, orderType, badShortOrder)
        await orderBook.connect(alice).placeOrder(badShortOrder, signature1)

        const badLongOrder = JSON.parse(JSON.stringify(longOrder))
        badLongOrder.price = ethers.utils.parseUnits('2000', 6)
        const order2Hash = await orderBook.getOrderHash(badLongOrder)
        const signature2 = await bob._signTypedData(domain, orderType, badLongOrder)
        await orderBook.connect(bob).placeOrder(badLongOrder, signature2)

        const tx = await orderBook.executeMatchedOrders(
            [ badLongOrder, badShortOrder ],
            [ signature2, signature1 ],
            longOrder.baseAssetQuantity
        )

        await expect(tx).to.emit(orderBook, 'OrderMatchingError')
        const event = await filterEvent(tx, 'OrderMatchingError')
        expect(event.args.orderHash).to.eq(order2Hash)
        expect(event.args.err).to.eq('AMM_price_increase_not_allowed')
        await assertPosSize(0, 0)
    })

    it('generic errors are not caught and bubbled up', async function() {
        await clearingHouse.setAMM(0, '0x0000000000000000000000000000000000000000')
        await expect(orderBook.executeMatchedOrders(
            [ longOrder, shortOrder ],
            [ signature2, signature1 ],
            longOrder.baseAssetQuantity
        // )).to.be.reverted
        )).to.be.revertedWith('without a reason string')

        await clearingHouse.setAMM(0, amm.address) // reset
        await assertPosSize(0, 0)
    })

    it('orders match when conditions are met', async function() {
        await addMargin(alice, _1e6.mul(1010)) // alice deposits margin so that is not the error scenario anymore

        const tx = await orderBook.executeMatchedOrders(
            [ longOrder, shortOrder ],
            [ signature2, signature1 ],
            longOrder.baseAssetQuantity
        )

        await expect(tx).to.emit(orderBook, 'OrdersMatched').withArgs(
            order2Hash,
            order1Hash,
            longOrder.baseAssetQuantity,
            longOrder.price,
            longOrder.baseAssetQuantity.mul(2),
            governance
        )

        expect((await orderBook.orderInfo(order1Hash)).status).to.eq(2) // filled
        expect((await orderBook.orderInfo(order2Hash)).status).to.eq(2) // filled

        const { alicePos, bobPos } = await assertPosSize(shortOrder.baseAssetQuantity, longOrder.baseAssetQuantity)

        const netQuote = longOrder.baseAssetQuantity.mul(longOrder.price).div(_1e18)
        expect(alicePos.openNotional).to.eq(netQuote)
        expect(bobPos.openNotional).to.eq(netQuote)
    })

    it('ch.liquidateSingleAmm fails', async function() {
        const { size } = await amm.positions(alice.address)
        charlie = signers[7]
        markPrice = _1e6.mul(1180)
        ;({ order, signature } = await placeOrder(size, markPrice, charlie, longOrder.expiry))
        // liquidate
        toLiquidate = size.mul(25e4).div(1e6).add(1) // 1/4th position liquidated
        let tx = await orderBook.liquidateAndExecuteOrder(alice.address, order, signature, toLiquidate.abs())

        await expect(tx).to.emit(orderBook, 'LiquidationError').withArgs(
            alice.address,
            ethers.utils.solidityKeccak256(['string'], ['LIQUIDATION_FAILED']),
            'CH: Above Maintenance Margin',
            toLiquidate.abs()
        )
        await assertPosSize(shortOrder.baseAssetQuantity, longOrder.baseAssetQuantity)
    })

    it('ch.liquidateSingleAmm fails - revert from amm', async function() {
        // force alice in liquidation zone
        await placeAndExecuteTrade(longOrder.baseAssetQuantity, markPrice, longOrder.expiry)
        expect(await clearingHouse.isAboveMaintenanceMargin(alice.address)).to.eq(false)

        let tx = await orderBook.liquidateAndExecuteOrder(alice.address, order, signature, toLiquidate.mul(2).abs())
        await expect(tx).to.emit(orderBook, 'LiquidationError').withArgs(
            alice.address,
            ethers.utils.solidityKeccak256(['string'], ['LIQUIDATION_FAILED']),
            'AMM_liquidating_too_much_at_once',
            toLiquidate.mul(2).abs()
        )
        await assertPosSize(shortOrder.baseAssetQuantity, longOrder.baseAssetQuantity)
    })

    it('ch.openPosition fails in liquidation', async function() {
        let tx = await orderBook.liquidateAndExecuteOrder(alice.address, order, signature, toLiquidate.abs())
        orderHash = await orderBook.getOrderHash(order)
        await expect(tx).to.emit(orderBook, 'LiquidationError').withArgs(
            alice.address,
            orderHash,
            'OrderMatchingError',
            toLiquidate.abs()
        )

        await expect(tx).to.emit(orderBook, 'OrderMatchingError').withArgs(
            orderHash,
            'CH: Below Minimum Allowable Margin'
        )
        await assertPosSize(shortOrder.baseAssetQuantity, longOrder.baseAssetQuantity)
    })

    it('generic errors are not caught and bubbled up', async function() {
        await clearingHouse.setAMM(0, '0x0000000000000000000000000000000000000000')
        await expect(orderBook.liquidateAndExecuteOrder(
            alice.address, order, signature, toLiquidate.abs())
        ).to.be.revertedWith('without a reason string')

        await clearingHouse.setAMM(0, amm.address) // reset
        await assertPosSize(shortOrder.baseAssetQuantity, longOrder.baseAssetQuantity)
        const charliePos = await hubbleViewer.userPositions(charlie.address)
        expect(charliePos[0].size).to.eq(0)
    })

    it('liquidations when all conditions met', async function() {
        await addMargin(charlie, _1e6.mul(2000))
        let tx = await orderBook.liquidateAndExecuteOrder(alice.address, order, signature, toLiquidate.abs())
        await expect(tx).to.emit(orderBook, 'LiquidationOrderMatched').withArgs(
            alice.address,
            orderHash,
            signature,
            toLiquidate.abs(),
            order.price,
            longOrder.baseAssetQuantity.mul(4),
            governance
        )
        await assertPosSize(shortOrder.baseAssetQuantity.sub(toLiquidate), longOrder.baseAssetQuantity)
        const charliePos = await hubbleViewer.userPositions(charlie.address)
        expect(charliePos[0].size).to.eq(toLiquidate)
    })
})

async function assertPosSize(s1, s2) {
    const [ [alicePos], [bobPos] ] = await Promise.all([
        hubbleViewer.userPositions(alice.address),
        hubbleViewer.userPositions(bob.address)
    ])
    expect(alicePos.size).to.eq(s1)
    expect(bobPos.size).to.eq(s2)
    return { alicePos, bobPos }
}

async function placeAndExecuteTrade(size, price, expiry) {
        const signer1 = signers[9]
        const signer2 = signers[8]
        await addMargin(signer1, _1e6.mul(_1e6))
        await addMargin(signer2, _1e6.mul(_1e6))

        const { order: order1, signature: signature1} = await placeOrder(size, price, signer1, expiry)
        const { order: order2, signature: signature2} = await placeOrder(size.mul(-1), price, signer2, expiry)

        await orderBook.executeMatchedOrders(
            [ order1, order2 ],
            [signature1, signature2],
            size.abs()
        )
}

async function placeOrder(size, price, signer, expiry) {
    if (!signer) {
        signer = signers[9]
        await addMargin(signer, _1e6.mul(_1e6))
    }

    const order = {
        ammIndex: ZERO,
        trader: signer.address,
        baseAssetQuantity: size,
        price: price,
        salt: BigNumber.from(Date.now()),
        expiry
    }

    const signature = await signer._signTypedData(domain, orderType, order)
    await orderBook.connect(signer).placeOrder(order, signature)
    return { order, signature }
}
