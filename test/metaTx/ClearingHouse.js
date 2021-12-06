const { expect } = require('chai');

const utils = require('../utils')

const {
    constants: { _1e6, _1e18, ZERO },
    assertions,
    parseRawEvent,
    signTransaction,
    setupContracts
} = utils

describe('Clearing House Meta Txs', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        relayer = signers[1]
    })

    beforeEach(async function() {
        contracts = await setupContracts()
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, forwarder, tradeFee } = contracts)
        // add margin
        margin = _1e6.mul(1000)
        await addMargin(signers[0], margin)
    })

    it('long', async () => {
        const baseAssetQuantity = _1e18.mul(5)
        amount = _1e6.mul(5025) // ~5x leverage

        const data = clearingHouse.interface.encodeFunctionData('openPosition', [ 0, baseAssetQuantity, amount ])
        const { sign, req } = await signTransaction(signers[0], clearingHouse, data, forwarder)
        expect(await forwarder.verify(req, sign)).to.equal(true);

        const tx = await forwarder.connect(relayer).metaExecute(req, sign);
        const positionModifiedEvent = await parseRawEvent(tx, clearingHouse, 'PositionModified')
        const quoteAsset = positionModifiedEvent.args.quoteAsset
        const fee = quoteAsset.mul(tradeFee).div(_1e6)

        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        expect(notionalPosition).gt(ZERO)
        expect(notionalPosition).lt(quoteAsset)
        expect(unrealizedPnl).lt(ZERO)
        await assertions(contracts, alice, {
            size: baseAssetQuantity,
            openNotional: quoteAsset,
            margin: margin.sub(fee)
        })
        expect(await amm.longOpenInterestNotional()).to.eq(baseAssetQuantity)
        expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        expect((await amm.lastPrice()).gt(_1e6.mul(1000))).to.be.true // rate increases after long

        const [ pos ] = await clearingHouse.userPositions(alice)
        expect(pos.size).to.eq(baseAssetQuantity)
        expect(pos.openNotional).to.eq(quoteAsset)
        expect(pos.unrealizedPnl).to.lt(ZERO)
        expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity))
    })

    it('short', async () => {
        const baseAssetQuantity = _1e18.mul(-5)
        amount = _1e6.mul(4975)

        const data = clearingHouse.interface.encodeFunctionData('openPosition', [ 0, baseAssetQuantity, amount ])
        const { sign, req } = await signTransaction(signers[0], clearingHouse, data, forwarder)
        expect(await forwarder.verify(req, sign)).to.equal(true);

        const tx = await forwarder.connect(relayer).metaExecute(req, sign);
        const positionModifiedEvent = await parseRawEvent(tx, clearingHouse, 'PositionModified')
        const quoteAsset = positionModifiedEvent.args.quoteAsset
        const fee = quoteAsset.mul(tradeFee).div(_1e6)

        // this asserts that short was executed at a price >= amount
        expect(quoteAsset.gte(amount)).to.be.true

        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        expect(notionalPosition).gt(quoteAsset)
        expect(unrealizedPnl).lt(ZERO)
        await assertions(contracts, alice, {
            size: baseAssetQuantity,
            openNotional: quoteAsset,
            margin: margin.sub(fee)
        })
        expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
        expect(await amm.shortOpenInterestNotional()).to.eq(baseAssetQuantity.abs())
        expect((await amm.lastPrice()).lt(_1e6.mul(1000))).to.be.true // rate decreases after short

        const [ pos ] = await clearingHouse.userPositions(alice)
        expect(pos.size).to.eq(baseAssetQuantity)
        expect(pos.openNotional).to.eq(quoteAsset)
        expect(pos.unrealizedPnl).to.lt(ZERO)
        expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity.mul(-1)))
    })

    it('above maintenance margin at the time of signing but falls below at execution', async function() {
        const baseAssetQuantity = _1e18.mul(-5)
        amount = _1e6.mul(4975)

        const data = clearingHouse.interface.encodeFunctionData('openPosition', [ 0, baseAssetQuantity, amount ])
        const { sign, req } = await signTransaction(signers[0], clearingHouse, data, forwarder)
        expect(await forwarder.verify(req, sign)).to.equal(true);

        await clearingHouse.openPosition(0, baseAssetQuantity, amount)
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true

        const bob = signers[1]
        await addMargin(bob, _1e6.mul(20000))
        await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), _1e6.mul(73000))

        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        try {
            await forwarder.connect(relayer).metaExecute(req, sign)
        } catch (error) {
            expect(error.message).to.contain('META_EXEC_FAILED:').and.contain('CH: Below Maintenance Margin')
        }
    })

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
