const fs = require('fs')
const { ethers } = require('hardhat')
const { sleep } = require('../../test/utils')
const { config } = require('./utils')
const utils = require('../../test/utils')
const {
    constants: { _1e6, _1e8, _1e18 },
} = utils

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

async function updatev120() {
    const [ signer ] = await ethers.getSigners()

    const vammAbiAndBytecode = fs.readFileSync('contracts/curve-v2/Swap.txt').toString().split('\n').filter(Boolean)
    const Swap = new ethers.ContractFactory(JSON.parse(vammAbiAndBytecode[0]), vammAbiAndBytecode[1], signer)
    const newVAMM = await Swap.deploy()
    console.log({ vammImpl: newVAMM.address }) // 0x709C86B7AB740a567feC23e8106AA9A99cdA12b8

    // const AMM = await ethers.getContractFactory('AMM')
    // const newAMM = await AMM.deploy(config.contracts.ClearingHouse, 86400)
    // console.log({ amm: newAMM.address })

    const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
    const newCH = await ClearingHouse.deploy('0xEd27FB82DAb4c5384B38aEe8d0Ab81B3b591C0FA') // trustedForwarder
    console.log({ newCH: newCH.address }) // 0x8a7F7218Ce0ACc1956D3722CEE5E4055079F057d

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

    await sleep(10)
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

async function leaderboard() {
    const Leaderboard = await ethers.getContractFactory('Leaderboard')
    const leaderboard = await Leaderboard.deploy(config.contracts.HubbleViewer)
    console.log({ leaderboard: leaderboard.address })
}

async function wethCollateral() {
    const weth = { address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB' }
    const marginAccount = await ethers.getContractAt('MarginAccount', config.contracts.MarginAccount)
    const oracle = await ethers.getContractAt('Oracle', config.contracts.Oracle)
    await oracle.setAggregator(weth.address, '0x976B3D034E162d8bD72D6b9C989d545b839003b0')
    await marginAccount.whitelistCollateral(weth.address, 8e5)
}

deployHubbleViewer()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
