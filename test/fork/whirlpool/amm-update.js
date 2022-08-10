const { expect } = require('chai')
const { ethers } = require('hardhat')

const config = {
    "genesisBlock": 11951773,
    "timestamp": 1658830227,
    "contracts": {
        "ClearingHouse": "0xd6693FA24b73d67ef8E19983cda7AAdAcc6B771A",
        "HubbleViewer": "0xFCaFA336F190532Dc9586FbFc6e409b3127180a3",
        "MarginAccount": "0x5124C2dD88B68DB9E5a142dB6E515E8325CeBd20",
        "Oracle": "0x17803c2abE66139d478fA36e4e5Fef4e3aa57054",
        "InsuranceFund": "0x4e3CF7C40FeB07689af4175f444B2a39633E8f4d",
        "Registry": "0xb3C825B5c692fe53054F04B80d947A1966446a28",
        "Leaderboard": "0xdD3f0a3710a4219F33D3919DD08657F2C92eCD5e",
        "MarginAccountHelper": "0x9F52Ec123A3180E6b2Ec6Bf16a41949dADF94a03",
        "HubbleReferral": "0x19A71B4A0F9DcE41366a5F0de4F808937f55948A",
        "usdc": "0xBdAB32601ABbD79efF36bB23A4EFEBE334ffA09c",
        "vusd": "0x4875E6621e9547f858fB88379B56909315607299",
        "amms": [
            {
                "perp": "AVAX-PERP",
                "address": "0x2F3363F05Aa37c18eb7BE4aE3E1bB51601237bA5",
                "underlying": "0xd00ae08403B9bbb9124bB305C09058E32C39A48c",
                "vamm": "0xdBf9c6EDFB852F19A57627196b1c7046FCBc45a3"
            }
        ],
        "collateral": [
            {
                "name": "Hubble USD",
                "ticker": "hUSD",
                "decimals": "6",
                "weight": "1000000",
                "address": "0x4875E6621e9547f858fB88379B56909315607299"
            },
            {
                "name": "Wrapped AVAX",
                "ticker": "WAVAX",
                "decimals": "18",
                "weight": "800000",
                "address": "0xd00ae08403B9bbb9124bB305C09058E32C39A48c"
            }
        ]
    },
    "systemParams": {
        "maintenanceMargin": "100000",
        "numCollateral": 2,
        "insuranceFundFee": "250",
        "liquidationFee": "50000"
    }
}

const deployer = '0x835cE0760387BC894E91039a88A00b6a69E65D94'
const proxyAdminAddy = '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD'
const maker = '0x36E24b66Cb2a474D20B33eb9EA49c3c39f1b3A90' // has liquidity

describe('(whirlpool fork) amm update', async function() {
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
