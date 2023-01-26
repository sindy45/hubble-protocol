const { expect } = require('chai')
const { ethers } = require('hardhat')

const { whirlpoolConfig: config } = require('../../../scripts/config')

const deployer = '0x835cE0760387BC894E91039a88A00b6a69E65D94'
const proxyAdminAddy = '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD'
const maker = '0x36E24b66Cb2a474D20B33eb9EA49c3c39f1b3A90' // has liquidity

describe.skip('(whirlpool fork) amm update', async function() {
    const blockTag = 12369306
    before(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
                    blockNumber: blockTag // having a consistent block number speeds up the tests across runs
                }
            }]
        })
        await impersonateAccount(deployer)

        clearingHouse = await ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse)
        amm = await ethers.getContractAt('AMM', config.contracts.amms[0].address)
        trader = '0xdad32fc8b47190eb3cb2d3ad9512f894e1762a2c'
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('liquidation bug', async function() {
        // https://testnet.snowtrace.io/tx/0x47b41b8bfea1ccb3cee837408f8858540bae7ab5f32ab34329c28ecb5e41ff7c
        await expect(
            clearingHouse.liquidateTaker(trader)
        ).to.revertedWith('SafeCast: value must be positive')
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

    it('liquidation passes', async function() {
        await amm.connect(ethers.provider.getSigner(deployer)).setLiquidationParams(25 * 1e4, 1e6)
        await amm.connect(ethers.provider.getSigner(deployer)).setPriceSpreadParams(20 * 1e4, 1e6)
        const clearingHouse = await ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse)
        await clearingHouse.liquidateTaker(trader)
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
