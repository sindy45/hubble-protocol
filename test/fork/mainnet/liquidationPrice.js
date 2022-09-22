const { expect } = require('chai')
const { ethers } = require('hardhat')
const { mainnetConfig: config } = require('../../../scripts/config')
const {
    forkCChain,
    calcMakerLiquidationPrice,
    constants: { _1e18, ZERO},
    impersonateAccount,
    setBalance,
    bnToFloat
} = require('../../utils')

const deployer = '0xF5c8E1eAFFD278A383C13061B4980dB7619479af' // mainnet
const Trader = '0xC32b7438b3dF7844c9eE799930a2224Fe6E26426' // has liquidity at 1.05x leverage and no taker position

describe('(fork mainnet) liquidation price', async function() {
    let blockTag = 20075658
    before(async function() {
        await forkCChain(blockTag)
        await impersonateAccount(deployer)
        signer = ethers.provider.getSigner(deployer)

        await setBalance(Trader, '0x56BC75E2D63100000') // 100 avax
        await impersonateAccount(Trader)
        trader = ethers.provider.getSigner(Trader)

        const LiquidationPriceViewer = await ethers.getContractFactory('LiquidationPriceViewer')
        ;([ clearingHouse, marginAccountHelper, liquidationPriceViewer ] = await Promise.all([
            ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse),
            ethers.getContractAt('MarginAccountHelper', config.contracts.MarginAccountHelper),
            LiquidationPriceViewer.deploy(config.contracts.HubbleViewer_1)
        ]))
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('maker leverage near 1x', async function() {
        // open taker position to check taker liquidation price
        await clearingHouse.connect(trader).openPosition(0, _1e18.mul(-20), 0)

        expect(bnToFloat(await liquidationPriceViewer.getMakerLeverage(Trader, 0)).toFixed(2)).to.eq('1.05')
        const liquidationPriceData  = await liquidationPriceViewer.getMakerLiquidationPrice(Trader, 0)
        const liquidationPrice = calcMakerLiquidationPrice(liquidationPriceData)
        expect(parseFloat(liquidationPrice.longLiqPrice).toFixed(3)).to.eq('0.112')
        expect(parseFloat(liquidationPrice.shortLiqPrice).toFixed(2)).to.eq('3912.70')

        const mf = bnToFloat(await clearingHouse.getMarginFraction(Trader))
        expect((1/mf).toFixed(2)).to.eq('2.75')
        expect(bnToFloat(await liquidationPriceViewer.getTakerLiquidationPrice(Trader, 0)).toFixed(2)).to.eq('23.31')
    })

    it('maker leverage < 0.909x', async function() {
        await marginAccountHelper.connect(trader).addMarginWithAvax({ value: _1e18.mul(3) })

        expect(bnToFloat(await liquidationPriceViewer.getMakerLeverage(Trader, 0)).toFixed(3)).to.eq('0.877')
        const liquidationPriceData  = await liquidationPriceViewer.getMakerLiquidationPrice(Trader, 0)
        const liquidationPrice = calcMakerLiquidationPrice(liquidationPriceData)
        expect(liquidationPrice.longLiqPrice).to.eq(ZERO)
        expect(liquidationPrice.shortLiqPrice).to.eq(ZERO)

        const mf = bnToFloat(await clearingHouse.getMarginFraction(Trader))
        expect((1/mf).toFixed(2)).to.eq('2.28')
        expect(bnToFloat(await liquidationPriceViewer.getTakerLiquidationPrice(Trader, 0)).toFixed(2)).to.eq('26.16')
    })


    it('increase maker leverage', async function() {
        await clearingHouse.connect(trader).addLiquidity(0, _1e18.mul(15), 0)

        expect(bnToFloat(await liquidationPriceViewer.getMakerLeverage(Trader, 0)).toFixed(2)).to.eq('2.96')
        const liquidationPriceData  = await liquidationPriceViewer.getMakerLiquidationPrice(Trader, 0)
        const liquidationPrice = calcMakerLiquidationPrice(liquidationPriceData)
        expect(parseFloat(liquidationPrice.longLiqPrice).toFixed(2)).to.eq('3.77')
        expect(parseFloat(liquidationPrice.shortLiqPrice).toFixed(2)).to.eq('83.23')

        const mf = bnToFloat(await clearingHouse.getMarginFraction(Trader))
        expect((1/mf).toFixed(2)).to.eq('4.37')
        expect(bnToFloat(await liquidationPriceViewer.getTakerLiquidationPrice(Trader, 0)).toFixed(2)).to.eq('23.62')
    })
})
