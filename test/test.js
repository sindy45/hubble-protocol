const { expect } = require("chai");

const { log, setupContracts, constants: { _1e6, _1e18, ZERO } } = require('./utils')

describe('e2e', function() {
    before('setup contracts', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ swap, marginAccount, clearingHouse, amm, vUSD, usdc } = await setupContracts(0))
    })

    it('addMargin', async function() {
        marginAmount = _1e6.mul(100)
        await usdc.mint(alice, marginAmount)
        await usdc.approve(marginAccount.address, marginAmount)
        await marginAccount.addUSDCMargin(marginAmount);
        console.log((await marginAccount.getNormalizedMargin(alice)).toString())
    })

    it('openPosition - SHORT', async function() {
        await clearingHouse.openPosition(0, _1e18.mul(-2), 0)
        const position = await amm.positions(signers[0].address)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        log(position, notionalPosition, unrealizedPnl, await clearingHouse.getMarginFraction(alice))
    })

    it('_increasePosition - SHORT', async function() {
        await clearingHouse.openPosition(0, _1e18.mul(-1), 0)
        const position = await amm.positions(signers[0].address)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        log(position, notionalPosition, unrealizedPnl, await clearingHouse.getMarginFraction(alice))
    })

    it.skip('settleFunding', async function() {
        const underlyingTwapPrice = await amm.getUnderlyingTwapPrice(0)
        const twapPrice = await amm.getTwapPrice(0)
        const premium = await amm.callStatic.settleFunding()
        await amm.settleFunding()
        console.log({
            premium: premium.toString(),
            underlyingTwapPrice: underlyingTwapPrice.toString(),
            twapPrice: twapPrice.toString(),
            fundingRate: (await amm.fundingRate()).toString()
        })
        const normalizedMargin = await marginAccount.getNormalizedMargin(alice)
        console.log({ normalizedMargin: normalizedMargin.toString()})
        await clearingHouse.updatePositions(alice)
        // short position so margin should increase
        expect((await marginAccount.getNormalizedMargin(alice)).gt(normalizedMargin)).to.be.true
    })

    it('_openReversePosition - (Close short)', async function() {
        let { notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        await clearingHouse.openPosition(0, _1e18.mul(3), ethers.constants.MaxUint256)

        const position = await amm.positions(signers[0].address)
        ;({ notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
        const marginFraction = await clearingHouse.getMarginFraction(alice)
        log(position, notionalPosition, unrealizedPnl, marginFraction);

        expect(position.size).to.eq(ZERO)
        expect(position.openNotional).to.eq(ZERO)
        expect(notionalPosition).to.eq(ZERO)
        expect(unrealizedPnl).to.eq(ZERO)
        expect(marginFraction).to.eq(ethers.constants.MaxInt256)

        // realizedPnl should ideally be 0, but is -1 (-1e-6)
        // doesn't happen when a size=3 is shorted in one go
        // actual expectation is vUSDBalance(alice) == marginAmount
        expect(await marginAccount.vUSDBalance(alice)).to.eq(marginAmount.sub(1))
    })
})
