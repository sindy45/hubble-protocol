const fs = require('fs')
const { ethers } = require('hardhat')

const { whirlpoolConfig: config } = require('../config')
const utils = require('../../test/utils')
const {
    constants: { _1e6, _1e8, _1e18 },
    sleep
} = utils

const contracts = config.contracts
const governance = '0x835cE0760387BC894E91039a88A00b6a69E65D94' // also deployer
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
    const amm = await ethers.getContractAt('AMM', config.contracts.amms[0].address)
    const AMM = await ethers.getContractFactory('AMM')
    const newAMM = await AMM.deploy(config.contracts.ClearingHouse, 86400)
    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', proxyAdminAddy)
    await proxyAdmin.upgrade(config.contracts.amms[0].address, newAMM.address)
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

/**
 * There's no yakSwap on fuji, this is just for consistency sake
 */
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

updateAMM()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
