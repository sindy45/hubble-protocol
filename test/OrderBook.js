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

        await orderBook.setValidatorStatus(signers[0].address, true)
        await addMargin(alice, _1e6.mul(4000))
        await addMargin(bob, _1e6.mul(4000))
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
            ]
        }
        shortOrder = {
            ammIndex: ZERO,
            trader: alice.address,
            baseAssetQuantity: ethers.utils.parseEther('-5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now())
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
            Object.values(shortOrder),
            signature1,
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
            salt: BigNumber.from(Date.now())
        }
        signature2 = await bob._signTypedData(domain, orderType, longOrder)
        await orderBook.connect(bob).placeOrder(longOrder, signature2)

        const tx = await orderBook.executeMatchedOrders(
            [ longOrder, shortOrder ],
            [ signature2, signature1 ],
            longOrder.baseAssetQuantity
        )

        order2Hash = await orderBook.getOrderHash(longOrder)

        await expect(tx).to.emit(orderBook, 'OrdersMatched')
        const event = await filterEvent(tx, 'OrdersMatched')
        expect(event.args.orders.slice(0)).to.deep.eq([ Object.values(longOrder), Object.values(shortOrder) ])
        expect(event.args.signatures).to.deep.eq([ signature2, signature1])
        expect(event.args.relayer).to.eq(governance)
        expect(event.args.fillAmount).to.eq(longOrder.baseAssetQuantity)

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
        await placeAndExecuteTrade(_1e18.mul(5), markPrice)
        expect(await clearingHouse.isAboveMaintenanceMargin(alice.address)).to.eq(false)
        expect(await clearingHouse.isAboveMaintenanceMargin(bob.address)).to.eq(true)
        const { size } = await amm.positions(alice.address)

        const charlie = signers[7]
        await addMargin(charlie, _1e6.mul(2000))
        const { order, signature } = await placeOrder(size, markPrice, charlie)

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

async function placeAndExecuteTrade(size, price) {
        const signer1 = signers[9]
        const signer2 = signers[8]
        await addMargin(signer1, _1e6.mul(_1e6))
        await addMargin(signer2, _1e6.mul(_1e6))

        const { order: order1, signature: signature1} = await placeOrder(size, price, signer1)
        const { order: order2, signature: signature2} = await placeOrder(size.mul(-1), price, signer2)

        await orderBook.executeMatchedOrders(
            [ order1, order2 ],
            [signature1, signature2],
            size.abs()
        )
}

async function placeOrder(size, price, signer) {
    if (!signer) {
        signer = signers[9]
        await addMargin(signer, _1e6.mul(_1e6))
    }

    const order = {
        ammIndex: ZERO,
        trader: signer.address,
        baseAssetQuantity: size,
        price: price,
        salt: BigNumber.from(Date.now())
    }

    const signature = await signer._signTypedData(domain, orderType, order)
    await orderBook.connect(signer).placeOrder(order, signature)
    return { order, signature }
}
