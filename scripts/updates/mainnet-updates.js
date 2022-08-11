const fs = require('fs')
const { ethers } = require('hardhat')


const utils = require('../../test/utils')
const {
    constants: { _1e6, _1e8, _1e18 },
} = utils

const config = {
    "genesisBlock": 18291062,
    "timestamp": 1659792695,
    "contracts": {
      "ClearingHouse": "0x4E3535964Cb5612a466d8bb25362d485452eFcEF",
      "HubbleViewer": "0x690EB0F0D9ddC1D3Df1a5E123000B95b8E708447",
      "MarginAccount": "0x7648675cA85DfB9e2F9C764EbC5e9661ef46055D",
      "Oracle": "0x7511E2ccAe82CdAb12d51F0d1519ad5450F157De",
      "InsuranceFund": "0x870850A72490379f60A4924Ca64BcA89a6D53a9d",
      "Registry": "0xfD704bc28097f1065640022Bee386985bDbc4122",
      "Leaderboard": "0xa3C1E96F7E788DF5a5923c064006e30D17AC588F",
      "BatchLiquidator": "0xeAAFe319454d7bE5C8E5f9Aa5585BeeBAa1BB727",
      "MarginAccountHelper": "0x9Cff75010B16404F2cD58556Db317607A1eebfc5",
      "HubbleReferral": "0x27f48404f6951702EAB36930a6671c459faC0B20",
      "usdc": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      "vusd": "0x5c6FC0AaF35A55E7a43Fff45575380bCEdb5Cbc2",
      "amms": [
        {
          "perp": "AVAX-PERP",
          "address": "0xD3575CC24dB98Bfa3C61Da7b484CF3a50a6f4fEd",
          "underlying": "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
          "vamm": "0x269Cd1827fCa5c4d3c7748C45708806c026052FE"
        }
      ],
      "collateral": [
        {
          "name": "Hubble USD",
          "ticker": "hUSD",
          "decimals": "6",
          "weight": "1000000",
          "address": "0x5c6FC0AaF35A55E7a43Fff45575380bCEdb5Cbc2"
        },
        {
          "name": "Wrapped AVAX",
          "ticker": "WAVAX",
          "decimals": "18",
          "weight": "800000",
          "address": "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"
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
const proxyAdminAddy = '0xddf407237BDe4d36287Be4De79D65c57AefBf8da'

async function liftOff() {
    const avaxAmm = await getContract('AMM', contracts.amms[0].address)
    await avaxAmm.liftOff()
}

function getContract(name, address) {
    return ethers.getContractAt(name, address || contracts[name])
}

async function deployBatchLiquidator() {
    const BatchLiquidator = await ethers.getContractFactory('BatchLiquidator')
    const batchLiquidator = await BatchLiquidator.deploy(
        contracts.ClearingHouse,
        contracts.MarginAccount,
        contracts.collateral[0].address,
        contracts.usdc,
        contracts.collateral[1].address, // wavax
        '0x60aE616a2155Ee3d9A68541Ba4544862310933d4' // joeRouter
    )
    console.log({ batchLiquidator: batchLiquidator.address }) // 0xeAAFe319454d7bE5C8E5f9Aa5585BeeBAa1BB727

    // const batchLiquidator = await getContract('BatchLiquidator')
    // console.log(await batchLiquidator.owner())
}

async function updatev110() {
    const [ signer ] = await ethers.getSigners()
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', proxyAdminAddy)

    const vammAbiAndBytecode = fs.readFileSync('contracts/curve-v2/Swap.txt').toString().split('\n').filter(Boolean)
    const Swap = new ethers.ContractFactory(JSON.parse(vammAbiAndBytecode[0]), vammAbiAndBytecode[1], signer)
    const newVAMM = await Swap.deploy()
    console.log({ vamm: newVAMM.address })

    const AMM = await ethers.getContractFactory('AMM')
    const newAMM = await AMM.deploy(config.contracts.ClearingHouse, 86400)
    console.log({ amm: newAMM.address })

    const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
    const newCH = await ClearingHouse.deploy('0xEd27FB82DAb4c5384B38aEe8d0Ab81B3b591C0FA') // trustedForwarder
    console.log({ newCH: newCH.address })

    await proxyAdmin.upgrade(config.contracts.amms[0].vamm, newVAMM.address)
    await proxyAdmin.upgrade(config.contracts.amms[0].address, newAMM.address)
    await proxyAdmin.upgrade(config.contracts.ClearingHouse, newCH.address)
}

updatev110()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
