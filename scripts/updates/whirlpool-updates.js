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
        "HubbleViewer": "0x4ecc1d18e39442d4671f10e921a3da63e757ba26",
        "LiquidationPriceViewer": "0xE219234455Fc75a12E3723100e6D0C4De77Fb9E9",
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
            },
            {
                "name": "Wrapped Ether",
                "ticker": "WETH.e",
                "decimals": "18",
                "weight": "800000",
                "address": "0x033e9a95D040B14bB960953D5456eC6b39fd72D5"
            }
        ],
        // older ones
        "HubbleViewer_0": "0xFCaFA336F190532Dc9586FbFc6e409b3127180a3",
        "HubbleViewer_1": "0x9f47D19bA2e45a8Bf6860f92f75bB2f124A9e058",
        "LiquidationPriceViewer_1": "0x9e8BB65d4f23DE948A351007011D66eFB75f970D"
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
        // '0x835cE0760387BC894E91039a88A00b6a69E65D94' // Deployer
        '0xB602D1acBC9ea756e1398AF87BB8b6de73BE8844' // liquidator
    ]
    const amount = _1e6.mul(10e6) // 10m
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


async function deployBatchLiquidator() {
    const BatchLiquidator = await ethers.getContractFactory('BatchLiquidator')
    const batchLiquidator = await BatchLiquidator.deploy(
        contracts.ClearingHouse,
        contracts.MarginAccount,
        contracts.collateral[0].address,
        contracts.usdc,
        contracts.collateral[1].address, // wavax
        '0xd7f655E3376cE2D7A2b08fF01Eb3B1023191A901' // joeRouter
    )
    console.log({ batchLiquidator: batchLiquidator.address }) // 0x85082B8B7c4B79aAfBBbA13b484A28D5A5202C93
}

async function updatev120() {
    const [ signer ] = await ethers.getSigners()

    const vammAbiAndBytecode = fs.readFileSync('contracts/curve-v2/Swap.txt').toString().split('\n').filter(Boolean)
    const Swap = new ethers.ContractFactory(JSON.parse(vammAbiAndBytecode[0]), vammAbiAndBytecode[1], signer)
    const newVAMM = await Swap.deploy()
    console.log({ vammImpl: newVAMM.address }) // 0x79Be6c6549eb0CAec8Ca58E2435ecdB6E447fC87

    // const AMM = await ethers.getContractFactory('AMM')
    // const newAMM = await AMM.deploy(config.contracts.ClearingHouse, 86400)
    // console.log({ amm: newAMM.address })

    const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
    const newCH = await ClearingHouse.deploy('0xaCEc31046a2B59B75E8315Fe4BCE4Da943237817') // trustedForwarder
    console.log({ newCH: newCH.address }) // 0x17c6E16F7EC6e17a9FA3786D28740e9551aeFb91

    const clearingHouse = ClearingHouse.attach(config.contracts.ClearingHouse)
    const vamm = Swap.attach(config.contracts.amms[0].vamm)

    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', proxyAdminAddy)
    await proxyAdmin.upgrade(config.contracts.amms[0].vamm, newVAMM.address)
    const newFee = '7500000' // 7.5 bps
    await vamm.setNewParameters(newFee)
    await clearingHouse.setParams(
      100000, // maintenanceMargin
      200000, // minAllowableMargin
      250, // tradeFee
      50000, // liquidationPenalty
      50, // referralShare
      100 // tradingFeeDiscount
  )
  await proxyAdmin.upgrade(config.contracts.ClearingHouse, newCH.address)
  // await proxyAdmin.upgrade(config.contracts.amms[0].address, newAMM.address)
}

async function deployHubbleViewer() {
    const HubbleViewer = await ethers.getContractFactory('HubbleViewer')
    hubbleViewer = await HubbleViewer.deploy(config.contracts.ClearingHouse, config.contracts.MarginAccount, config.contracts.Registry)

    await utils.sleep(10)
    const LiquidationPriceViewer = await ethers.getContractFactory('LiquidationPriceViewer')
    liquidationPriceViewer = await LiquidationPriceViewer.deploy(hubbleViewer.address)

    console.log({
        hubbleViewer: hubbleViewer.address,
        liquidationPriceViewer: liquidationPriceViewer.address
    })
}

async function deployLiquidationPriceViewer() {
    const LiquidationPriceViewer = await ethers.getContractFactory('LiquidationPriceViewer')
    const liquidationPriceViewer = await LiquidationPriceViewer.deploy(config.contracts.HubbleViewer)
    console.log({ liquidationPriceViewer: liquidationPriceViewer.address })
}

async function wethCollateral() {
    const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    const weth = await ERC20Mintable.deploy('Hubble weth', 'WETH.e', 18)
    console.log({ weth: weth.address })

    const marginAccount = await ethers.getContractAt('MarginAccount', config.contracts.MarginAccount)
    const oracle = await ethers.getContractAt('Oracle', config.contracts.Oracle)
    await oracle.setAggregator(weth.address, '0x86d67c3D38D2bCeE722E601025C25a575021c6EA')
    await marginAccount.whitelistCollateral(weth.address, 8e5)
}

deployHubbleViewer()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
