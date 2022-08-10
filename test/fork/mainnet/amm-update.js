const { expect } = require('chai')
const { ethers } = require('hardhat')
const { config } = require('./utils')

const deployer = '0xF5c8E1eAFFD278A383C13061B4980dB7619479af'
const proxyAdminAddy = '0xddf407237BDe4d36287Be4De79D65c57AefBf8da'
const maker = '0x6D3Ee34A020e7565e78540C74300218104C8e4a9' // has liquidity
const trader = '0x562574AF66836b1d30e69815bDf0740A7BD7C437' // has open position at block 18435700

describe('(fork) amm update', async function() {
    const blockTag = 18435700
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

        clearingHouse = await ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse)
        amm = await ethers.getContractAt('AMM', config.contracts.amms[0].address)
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('update AMM', async function() {
        vars1 = await getAMMVars(amm, trader)
        const AMM = await ethers.getContractFactory('AMM')
        const newAMM = await AMM.deploy(config.contracts.ClearingHouse, 86400)
        const proxyAdmin = await ethers.getContractAt('ProxyAdmin', proxyAdminAddy)
        await proxyAdmin.connect(ethers.provider.getSigner(deployer)).upgrade(config.contracts.amms[0].address, newAMM.address)
    })

    it('storage vars remain same', async function() {
        const vars2 = await getAMMVars(amm, trader)
        expect(vars2).to.deep.equal(vars1)
    })
})

function getAMMVars(amm, trader) {
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
        amm.maxOracleSpreadRatio(),
        amm.maxLiquidationRatio(),
        amm.maxLiquidationPriceSpread(),
        amm.positions(trader),
        amm.makers(maker), // has liquidity
        amm.withdrawPeriod(),
        amm.unbondPeriod(),
        amm.ignition(),
        amm.ammState(),
        amm.minSizeRequirement(),
    ])
}

async function impersonateAccount(account) {
    await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [account],
    })
}
