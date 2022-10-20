const fs = require('fs')
const { ethers } = require('hardhat')

const { mainnetConfig: config } = require('../config')
const utils = require('../../test/utils')
const {
    constants: { _1e6, _1e8, _1e18 },
    sleep
} = utils

const contracts = config.contracts
const governance = '0xF5c8E1eAFFD278A383C13061B4980dB7619479af' // also deployer
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

async function yakSwap() {
    const PortfolioManager = await ethers.getContractFactory('PortfolioManager')
    const portfolioManager = await PortfolioManager.deploy(contracts.Registry, contracts.thirdParty.YakRouter)
    await sleep(5)
    console.log({ portfolioManager: portfolioManager.address })

    const MarginAccount = await ethers.getContractFactory('MarginAccount')
    const newMarginAccount = await MarginAccount.deploy(contracts.TrustedForwarder)
    await sleep(5)
    console.log({ newMarginAccount: newMarginAccount.address })

    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', proxyAdminAddy)
    await proxyAdmin.upgrade(contracts.MarginAccount, newMarginAccount.address)
    await sleep(5)

    const marginAccount = await ethers.getContractAt('MarginAccount', contracts.MarginAccount)
    await marginAccount.setPortfolioManager(portfolioManager.address)
}

async function updateAMM() {
    const amm = await ethers.getContractAt('AMM', config.contracts.amms[0].address)
    const AMM = await ethers.getContractFactory('AMM')
    const newAMM = await AMM.deploy(config.contracts.ClearingHouse, 86400)
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', proxyAdminAddy)
    await proxyAdmin.upgrade(config.contracts.amms[0].address, '0xe807aeba82bfe7887da0640fe5a52c43bb31d9aa') // newAMM.address
    await utils.sleep(5)

    const maxOracleSpreadRatio = 5 * 1e4 // 5%
    const maxPriceSpreadPerBlock = 1 * 1e4 // 1%
    await amm.setPriceSpreadParams(maxOracleSpreadRatio, maxPriceSpreadPerBlock)

    const maxLiquidationRatio = 25 * 1e4 // 25%
    const maxLiquidationPriceSpread = 1 * 1e4 // 1%
    await amm.setLiquidationParams(maxLiquidationRatio, maxLiquidationPriceSpread)

    // set maxFunding rate = 43.8% annual = 0.005% hourly
    const maxFundingRate = 50 // 0.005% = .00005 * 1e6 = 50
    await amm.setMaxFundingRate(maxFundingRate)
}

updateAMM()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
