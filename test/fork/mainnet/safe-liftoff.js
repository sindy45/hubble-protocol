const { expect } = require('chai')
const {
    bnToFloat,
    constants: { _1e6, _1e18, ZERO },
    getTradeDetails,
    getTwapPrice,
    gotoNextFundingTime
} = require('../../utils')
const { config } = require('./utils')

const deployer = '0xF5c8E1eAFFD278A383C13061B4980dB7619479af'
const maker = '0x11d67Fa925877813B744aBC0917900c2b1D6Eb81' // committed 500k liquidity
const alice = ethers.provider.getSigner('0x6b365af8d060e7f7989985d62485357e34e2e8f5') // 4m usdc
const bob = ethers.provider.getSigner('0xeeEa93BAd21eefBf4A7e201c680Ebc7bf334Cd60') // 15k avax

describe('(fork) safe liftoff', async function() {
    const blockTag = 18379122
    before(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
                    blockNumber: blockTag // having a consistent block number speeds up the tests across runs
                }
            }]
        })
        await impersonateAccount(deployer)
        // await setBalance(liquidatorBot, '0x8AC7230489E80000') // 10 avax to pay for gas fee
        ;([
            amm, hubbleViewer, clearingHouse, marginAccountHelper,
            marginAccount, usdc, hUSD, oracle
        ] = await Promise.all([
            ethers.getContractAt('AMM', config.contracts.amms[0].address),
            ethers.getContractAt('HubbleViewer', config.contracts.HubbleViewer),
            ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse),
            ethers.getContractAt('MarginAccountHelper', config.contracts.MarginAccountHelper),
            ethers.getContractAt('MarginAccount', config.contracts.MarginAccount),
            ethers.getContractAt('IERC20', config.contracts.usdc),
            ethers.getContractAt('VUSD', config.contracts.vusd),
            ethers.getContractAt('Oracle', config.contracts.Oracle)
        ]))
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('liftOff', async function() {
        await amm.connect(ethers.provider.getSigner(deployer)).liftOff()
        expect(await amm.ammState()).to.eq(2)
        expect(bnToFloat(await amm.lastPrice())).to.approximately(29.364032, 1e-6)

        expect(bnToFloat((await amm.makers(maker)).dToken, 18)).to.eq(0)
        await clearingHouse.updatePositions(maker)
        expect(bnToFloat((await amm.makers(maker)).dToken, 18)).to.eq(46135.17415178151)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(maker)
        expect(notionalPosition).to.eq(_1e6.mul(500000))
        expect(unrealizedPnl).to.eq(ZERO)
    })

    it('open position', async function() {
        await impersonateAccount(alice._address)
        const margin = _1e6.mul(2000)
        await usdc.connect(alice).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(alice).addVUSDMarginWithReserve(margin)

        let baseAsset = _1e18.div(10)
        let quote = await hubbleViewer.getQuote(baseAsset, 0)
        await expect(clearingHouse.connect(alice).openPosition(0, baseAsset, quote)).to.be.revertedWith('position_less_than_minSize')
        baseAsset = _1e18.mul(10)
        quote = await hubbleViewer.getQuote(baseAsset, 0)
        const IFBalance = await hUSD.balanceOf(config.contracts.InsuranceFund)
        const tx = await clearingHouse.connect(alice).openPosition(0, baseAsset, quote)

        const [ pos ] = await hubbleViewer.userPositions(alice._address)
        expect(pos.size).to.eq(baseAsset)
        expect(bnToFloat(pos.openNotional)).to.approximately(bnToFloat(quote), 1e-6)
        expect(bnToFloat(await amm.lastPrice())).to.approximately(29.364361, 1e-6)

        const { fee } = await getTradeDetails(tx, config.systemParams.insuranceFundFee)
        expect(fee).to.gt(ZERO)
        expect(await hUSD.balanceOf(config.contracts.InsuranceFund)).to.eq(IFBalance.add(fee))
    })

    it('add liquidity', async function() {
        await impersonateAccount(bob._address)
        const margin = _1e18.mul(100)
        await marginAccountHelper.connect(bob).addMarginWithAvax({value: margin})

        let liquidityAmount  = _1e18.mul(220)
        await expect(clearingHouse.connect(bob).addLiquidity(0, liquidityAmount, 0)).to.be.revertedWith(
            'CH: Below Minimum Allowable Margin'
        )
        liquidityAmount  = _1e18.mul(199)
        const { dToken } = await hubbleViewer.getMakerQuote(0, liquidityAmount, true, true)
        await clearingHouse.connect(bob).addLiquidity(0, liquidityAmount, dToken)

        let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(bob._address)
        expect(bnToFloat(size, 18)).to.eq(-0.001994504514533732)
        expect(openNotional).to.eq(ZERO)
        expect(bnToFloat(notionalPosition)).eq(11697.388430) // 199*29.36*2 = 11677.32
        expect(bnToFloat(unrealizedPnl)).to.eq(-0.117217)
        expect(await clearingHouse.calcMarginFraction(bob._address, true, 1)).to.eq(200706) // ~5x leverage
    })

    it('funding payment', async function() {
        let tx = await clearingHouse.settleFunding()
        expect((await tx.wait()).events.length).to.eq(0)

        await gotoNextFundingTime(amm)
        tx = await clearingHouse.settleFunding()
        expect((await tx.wait()).events.length).to.eq(1)
        const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

        const oraclePriceTwap = await oracle.getUnderlyingTwapPrice(config.contracts.collateral[1].address, 3600)
        const markPriceTwap = await getTwapPrice(amm, 3600, fundingTimestamp)
        expect(oraclePriceTwap).to.gt(markPriceTwap) // shorts pay long

        const premiumFraction = await amm.cumulativePremiumFraction()
        expect(premiumFraction).to.eq(markPriceTwap.sub(oraclePriceTwap).div(24))

        const { makerFundingPayment, takerFundingPayment } =  await amm.getPendingFundingPayment(alice._address)
        expect(makerFundingPayment).to.eq(ZERO)
        expect(takerFundingPayment).to.lt(ZERO)
        expect(takerFundingPayment).to.eq(premiumFraction.mul(10)) // long 10
    })
    // remove liquidity
    // referral
    // liquidation
})

async function impersonateAccount(account) {
    await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [account],
    })
}
