const fs = require('fs')
const { ethers } = require('hardhat')


const utils = require('../../test/utils')
const {
    constants: { _1e6, _1e8, _1e18 },
} = utils

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

const contracts = config.contracts
const proxyAdminAddy = '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD'

async function generateConfig() {
    console.log(
        JSON.stringify(await utils.generateConfig(contracts.Leaderboard, contracts.MarginAccountHelper, null, config.genesisBlock), null, 4)
    )
}

function getContract(name, address) {
    return ethers.getContractAt(name, address || config[name])
}

async function liftOff() {
    const avaxAmm = await getContract('AMM', contracts.amms[0].address)
    await avaxAmm.liftOff()
}

async function mintUSDC() {
    const usdc = await getContract('ERC20Mintable', contracts.usdc)
    const recipients = [
        // '0xC0BCb6F17Ef0Dd784dcb5a12Bb9Ea9253C1dd998', // faucet
        '0x835cE0760387BC894E91039a88A00b6a69E65D94' // Deployer
    ]
    const amount = _1e6.mul(2e6)
    for (let i = 0; i < recipients.length; i++) {
        await usdc.mint(recipients[i], amount)
    }
}

async function updateAMM() {
    const AMM = await ethers.getContractFactory('AMM')
    const newAMM = await AMM.deploy(config.contracts.ClearingHouse, 86400)
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', proxyAdminAddy)
    await proxyAdmin.upgrade(config.contracts.amms[0].address, newAMM.address)
}

updateAMM()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
