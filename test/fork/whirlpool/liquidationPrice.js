const { expect } = require('chai')
const { ethers } = require('hardhat')
const { whirlpoolConfig: config } = require('../../../scripts/config')
const {
    calcMakerLiquidationPrice,
    forkFuji,
    constants: { _1e18, ZERO },
    impersonateAccount,
    bnToFloat
} = require('../../utils')

const deployer = '0x835cE0760387BC894E91039a88A00b6a69E65D94' // whirlpool
const Trader = '0x831706473e5bfe54987f4d09eb1d8252742aae6e' // 1900 short avax at forked block

describe('(fork) liquidation price', async function() {
    let blockTag = 13665550
    before(async function() {
        await forkFuji(blockTag)
        await impersonateAccount(deployer)
        signer = ethers.provider.getSigner(deployer)

        await impersonateAccount(Trader)
        trader = ethers.provider.getSigner(Trader)

        const LiquidationPriceViewer = await ethers.getContractFactory('LiquidationPriceViewer')
        ;([ clearingHouse, amm, liquidationPriceViewer ] = await Promise.all([
            ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse),
            ethers.getContractAt('IAMM_old', config.contracts.amms[0].address),
            LiquidationPriceViewer.deploy(config.contracts.HubbleViewer_0)
        ]))
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('maker leverage < 0.909x', async function() {
        await clearingHouse.connect(trader).addLiquidity(0, _1e18.mul(400), 0)

        expect(bnToFloat(await liquidationPriceViewer.getMakerLeverage(Trader, 0)).toFixed(3)).to.eq('0.906')
        const liquidationPriceData  = await liquidationPriceViewer.getMakerLiquidationPrice(Trader, 0)
        const liquidationPrice = calcMakerLiquidationPrice(liquidationPriceData)
        expect(liquidationPrice.longLiqPrice).to.eq(ZERO)
        expect(liquidationPrice.shortLiqPrice).to.eq(ZERO)

        const mf = bnToFloat(await clearingHouse.getMarginFraction(Trader))
        expect((1/mf).toFixed(2)).to.eq('2.23')
        expect(bnToFloat(await liquidationPriceViewer.getTakerLiquidationPrice(Trader, 0)).toFixed(2)).to.eq('27.20')
    })

    it('maker leverage just > 0.909x', async function() {
        await clearingHouse.connect(trader).addLiquidity(0, _1e18.mul(5), 0)

        expect(bnToFloat(await liquidationPriceViewer.getMakerLeverage(Trader, 0)).toFixed(3)).to.eq('0.913')
        const liquidationPriceData  = await liquidationPriceViewer.getMakerLiquidationPrice(Trader, 0)
        const liquidationPrice = calcMakerLiquidationPrice(liquidationPriceData)
        expect(parseFloat(liquidationPrice.longLiqPrice).toFixed(7)).to.eq('0.0000413')
        expect(parseFloat(liquidationPrice.shortLiqPrice).toFixed(2)).to.eq('9547175.34')

        const mf = bnToFloat(await clearingHouse.getMarginFraction(Trader))
        expect((1/mf).toFixed(2)).to.eq('2.23')
        expect(bnToFloat(await liquidationPriceViewer.getTakerLiquidationPrice(Trader, 0)).toFixed(2)).to.eq('27.19')
    })

    it('increase maker leverage', async function() {
        await clearingHouse.connect(trader).addLiquidity(0, _1e18.mul(1000), 0)

        expect(bnToFloat(await liquidationPriceViewer.getMakerLeverage(Trader, 0)).toFixed(2)).to.eq('2.23')
        const liquidationPriceData  = await liquidationPriceViewer.getMakerLiquidationPrice(Trader, 0)
        const liquidationPrice = calcMakerLiquidationPrice(liquidationPriceData)
        expect(parseFloat(liquidationPrice.longLiqPrice).toFixed(2)).to.eq('2.62')
        expect(parseFloat(liquidationPrice.shortLiqPrice).toFixed(2)).to.eq('140.98')

        const mf = bnToFloat(await clearingHouse.getMarginFraction(Trader))
        expect((1/mf).toFixed(2)).to.eq('3.55')
        expect(bnToFloat(await liquidationPriceViewer.getTakerLiquidationPrice(Trader, 0)).toFixed(2)).to.eq('25.39')
    })

    it('reduce taker position', async function() {
        await amm.connect(signer).setMaxOracleSpreadRatio(100) // to avoid 'longs not allowed'
        await clearingHouse.connect(trader).openPosition(0, _1e18.mul(1800), ethers.constants.MaxUint256)

        expect(bnToFloat(await liquidationPriceViewer.getMakerLeverage(Trader, 0)).toFixed(2)).to.eq('2.23')
        const liquidationPriceData  = await liquidationPriceViewer.getMakerLiquidationPrice(Trader, 0)
        const liquidationPrice = calcMakerLiquidationPrice(liquidationPriceData)
        expect(parseFloat(liquidationPrice.longLiqPrice).toFixed(2)).to.eq('2.62')
        expect(parseFloat(liquidationPrice.shortLiqPrice).toFixed(2)).to.eq('140.90')

        const mf = bnToFloat(await clearingHouse.getMarginFraction(Trader))
        expect((1/mf).toFixed(2)).to.eq('2.30')
        expect(bnToFloat(await liquidationPriceViewer.getTakerLiquidationPrice(Trader, 0)).toFixed(2)).to.eq('218.60')
    })
})
