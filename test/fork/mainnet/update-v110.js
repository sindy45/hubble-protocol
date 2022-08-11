const { expect } = require('chai')
const { ethers } = require('hardhat')
const { config } = require('./utils')
const fs = require('fs')

const deployer = '0xF5c8E1eAFFD278A383C13061B4980dB7619479af'
const proxyAdminAddy = '0xddf407237BDe4d36287Be4De79D65c57AefBf8da'
const maker = '0x6D3Ee34A020e7565e78540C74300218104C8e4a9' // has liquidity
const trader = '0x562574AF66836b1d30e69815bDf0740A7BD7C437' // has open position at block 18435700

describe('(fork) v1.1.0 update', async function() {
    const blockTag = 18503230
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
        signer = ethers.provider.getSigner(deployer)
        ;([ clearingHouse, amm, proxyAdmin ] = await Promise.all([
            ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse),
            ethers.getContractAt('AMM', config.contracts.amms[0].address),
            ethers.getContractAt('ProxyAdmin', proxyAdminAddy)
        ]))
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('update AMM', async function() {
        const vars1 = await getAMMVars(amm, trader)

        const AMM = await ethers.getContractFactory('AMM')
        const newAMM = await AMM.deploy(config.contracts.ClearingHouse, 86400)
        await proxyAdmin.connect(signer).upgrade(config.contracts.amms[0].address, newAMM.address)

        const vars2 = await getAMMVars(amm, trader)
        expect(vars2).to.deep.equal(vars1)
    })

    it('update vAMM', async function() {
        vammAbiAndBytecode = fs.readFileSync('contracts/curve-v2/Swap.txt').toString().split('\n').filter(Boolean)
        Swap = new ethers.ContractFactory(JSON.parse(vammAbiAndBytecode[0]), vammAbiAndBytecode[1], signer)
        const vamm = Swap.attach(config.contracts.amms[0].vamm)
        const vars1 = await getVAMMVars(vamm)

        const newVAMM = await Swap.deploy()
        await proxyAdmin.connect(signer).upgrade(config.contracts.amms[0].vamm, newVAMM.address)

        const vars2 = await getVAMMVars(vamm)
        expect(vars2).to.deep.equal(vars1)
    })

    it('update ClearingHouse', async function() {
        const vars1 = await getCHVars(clearingHouse)

        const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
        const newClearingHouse = await ClearingHouse.deploy('0xEd27FB82DAb4c5384B38aEe8d0Ab81B3b591C0FA') // trustedForwarder
        await proxyAdmin.connect(signer).upgrade(config.contracts.ClearingHouse, newClearingHouse.address)

        const vars2 = await getCHVars(clearingHouse)
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

function getCHVars(ch) {
    return Promise.all([
        ch.maintenanceMargin(),
        ch.tradeFee(),
        ch.liquidationPenalty(),
        ch.fixedMakerLiquidationFee(),
        ch.minAllowableMargin(),
        ch.referralShare(),
        ch.tradingFeeDiscount(),
        ch.vusd(),
        ch.marginAccount(),
        ch.amms(0),
        ch.hubbleReferral(),
    ])
}

function getVAMMVars(vamm) {
    const gasLimit = 1e6
    return Promise.all([
        vamm.totalSupply({ gasLimit }),
        vamm.price_scale({ gasLimit }),
        vamm.price_oracle({ gasLimit }),
        vamm.mark_price({ gasLimit }),
        vamm.last_prices({ gasLimit }),
        vamm.last_prices_timestamp({ gasLimit }),

        vamm.balances(0, { gasLimit }),
        vamm.balances(1, { gasLimit }),

        vamm.D({ gasLimit }),
        vamm.admin_actions_deadline({ gasLimit }), // last variable
    ])
}

async function impersonateAccount(account) {
    await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [account],
    })
}
