
const { expect } = require('chai')
const { ethers } = require('hardhat')

const {
    impersonateAccount,
    constants: { _1e18, _1e6, _1e12 },
    forkCChain
} = require('../../utils')
const { mainnetConfig: config } = require('../../../scripts/config')

const deployer = '0xF5c8E1eAFFD278A383C13061B4980dB7619479af'
const proxyAdminAddy = '0xddf407237BDe4d36287Be4De79D65c57AefBf8da'
const trader = '0x562574AF66836b1d30e69815bDf0740A7BD7C437'
const maker = '0x84E01061fa6b69C1629E3578d988eb20CB73A677'

describe.skip('v1.4.0 update', async function() {
    const blockTag = 21220909
    before(async function() {
        await forkCChain(blockTag)
        await impersonateAccount(deployer)
        signer = ethers.provider.getSigner(deployer)
        ;([ clearingHouse, amm, proxyAdmin ] = await Promise.all([
            ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse),
            ethers.getContractAt('AMM', config.contracts.amms[0].address),
            ethers.getContractAt('ProxyAdmin', proxyAdminAddy),
        ]))
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('update AMM', async function() {
        const vars1 = await getAMMVars(amm, trader, maker)

        const AMM = await ethers.getContractFactory('AMM')
        const newAMM = await AMM.deploy(config.contracts.ClearingHouse, 86400)
        await proxyAdmin.connect(signer).upgrade(config.contracts.amms[0].address, newAMM.address)
        const maxPriceSpreadPerBlock = 1 * 1e4 // 1%
        const maxOracleSpreadRatio = 5 * 1e4 // 5%
        const maxLiquidationRatio = 25 * 1e4 // 25%
        const maxLiquidationPriceSpread = 1 * 1e4 // 1%
        await amm.connect(signer).setPriceSpreadParams(maxOracleSpreadRatio, maxPriceSpreadPerBlock)
        await amm.connect(signer).setLiquidationParams(maxLiquidationRatio, maxLiquidationPriceSpread)
        // set maxFunding rate = 50% annual = 0.00570776% hourly
        const maxFundingRate = 0.0057 * 1e4
        await amm.connect(signer).setMaxFundingRate(maxFundingRate)

        const vars2 = await getAMMVars(amm, trader, maker)
        expect(vars2).to.deep.equal(vars1)
        expect(await amm.maxFundingRate()).to.eq(maxFundingRate)
        expect(await amm.maxPriceSpreadPerBlock()).to.eq(maxPriceSpreadPerBlock)
        expect(await amm.maxOracleSpreadRatio()).to.eq(maxOracleSpreadRatio)
        expect(await amm.maxLiquidationRatio()).to.eq(maxLiquidationRatio)
        expect(await amm.maxLiquidationPriceSpread()).to.eq(maxLiquidationPriceSpread)
    })

    it('trade', async function() {
        await impersonateAccount(trader)
        await clearingHouse.connect(ethers.provider.getSigner(trader)).openPosition(0, _1e18.mul(-5), 0)
        await clearingHouse.connect(ethers.provider.getSigner(trader)).openPosition(0, _1e18.mul(20), _1e12)
    })
})

function getAMMVars(amm, trader, maker = trader) {
    return Promise.all([
        amm.vamm(),
        amm.underlyingAsset(),
        amm.name(),
        amm.fundingBufferPeriod(),
        amm.nextFundingTime(),
        amm.cumulativePremiumFraction(),
        amm.cumulativePremiumPerDtoken(),
        amm.posAccumulator(),
        amm.longOpenInterestNotional(),
        amm.shortOpenInterestNotional(),
        amm.positions(trader),
        amm.makers(maker), // has liquidity
        amm.withdrawPeriod(),
        amm.unbondPeriod(),
        amm.ignition(),
        amm.ammState(),
        amm.minSizeRequirement(),
    ])
}
