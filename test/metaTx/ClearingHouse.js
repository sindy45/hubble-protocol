const { expect } = require('chai');

const utils = require('../utils')

const {
    constants: { _1e6, _1e18, ZERO },
    assertions,
    parseRawEvent,
    signTransaction,
    setupContracts,
    setDefaultClearingHouseParams
} = utils

describe('Clearing House Meta Txs', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        relayer = signers[1]
    })

    beforeEach(async function() {
        contracts = await setupContracts()
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, forwarder, tradeFee, hubbleViewer } = contracts)
        await setDefaultClearingHouseParams(clearingHouse)
        // add margin
        margin = _1e6.mul(1000)
        await addMargin(signers[0], margin)
    })

    it('long', async () => {
        const baseAssetQuantity = _1e18.mul(5)
        amount = _1e6.mul(5025) // ~5x leverage

        const data = clearingHouse.interface.encodeFunctionData('openPosition2', [ 0, baseAssetQuantity, amount ])
        const { sign, req } = await signTransaction(signers[0], clearingHouse, data, forwarder)
        expect(await forwarder.verify(req, sign)).to.equal(true);

        const tx = await forwarder.connect(relayer).executeRequiringSuccess(req, sign);
        const positionModifiedEvent = await parseRawEvent(tx, clearingHouse, 'PositionModified')
        const quoteAsset = positionModifiedEvent.args.quoteAsset
        const fee = quoteAsset.mul(tradeFee).div(_1e6)

        await assertions(contracts, alice, {
            size: baseAssetQuantity,
            openNotional: quoteAsset,
            notionalPosition: quoteAsset,
            unrealizedPnl: ZERO,
            margin: margin.sub(fee)
        })
        expect(await amm.longOpenInterestNotional()).to.eq(baseAssetQuantity)
        expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)

        const [ pos ] = await hubbleViewer.userPositions(alice)
        expect(pos.size).to.eq(baseAssetQuantity)
        expect(pos.openNotional).to.eq(quoteAsset)
        expect(pos.unrealizedPnl).to.eq(ZERO)
        expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity))
    })

    it('short', async () => {
        const baseAssetQuantity = _1e18.mul(-5)
        amount = _1e6.mul(4975)

        const data = clearingHouse.interface.encodeFunctionData('openPosition2', [ 0, baseAssetQuantity, amount ])
        const { sign, req } = await signTransaction(signers[0], clearingHouse, data, forwarder)
        expect(await forwarder.verify(req, sign)).to.equal(true);

        const tx = await forwarder.connect(relayer).executeRequiringSuccess(req, sign);
        const positionModifiedEvent = await parseRawEvent(tx, clearingHouse, 'PositionModified')
        const quoteAsset = positionModifiedEvent.args.quoteAsset
        const fee = quoteAsset.mul(tradeFee).div(_1e6)

        // this asserts that short was executed at a price >= amount
        expect(quoteAsset.gte(amount)).to.be.true

        await assertions(contracts, alice, {
            size: baseAssetQuantity,
            openNotional: quoteAsset,
            notionalPosition: quoteAsset,
            unrealizedPnl: ZERO,
            margin: margin.sub(fee)
        })
        expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
        expect(await amm.shortOpenInterestNotional()).to.eq(baseAssetQuantity.abs())

        const [ pos ] = await hubbleViewer.userPositions(alice)
        expect(pos.size).to.eq(baseAssetQuantity)
        expect(pos.openNotional).to.eq(quoteAsset)
        expect(pos.unrealizedPnl).to.eq(ZERO)
        expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity.mul(-1)))
    })

    it('above maintenance margin at the time of signing but falls below at execution', async function() {
        const baseAssetQuantity = _1e18.mul(-5)
        amount = _1e6.mul(4975)

        const data = clearingHouse.interface.encodeFunctionData('openPosition2', [ 0, baseAssetQuantity, amount ])
        const { sign, req } = await signTransaction(signers[0], clearingHouse, data, forwarder)
        expect(await forwarder.verify(req, sign)).to.equal(true);

        await clearingHouse.openPosition2(0, baseAssetQuantity, amount)
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true

        // bob increases the price
        bob = signers[1]
        const base = _1e18.mul(15)
        const price = _1e6.mul(1130)
        await addMargin(bob, base.mul(price).div(_1e18))
        await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))

        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        try {
            await forwarder.connect(relayer).executeRequiringSuccess(req, sign)
        } catch (error) {
            expect(error.message).to.contain('META_EXEC_FAILED:').and.contain('CH: Below Minimum Allowable Margin')
        }
    })

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
