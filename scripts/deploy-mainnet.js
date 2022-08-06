const { expect } = require('chai')
const { ethers } = require('hardhat')
const utils = require('../test/utils')

const {
    constants: { _1e18 },
    setupContracts,
    setupAmm,
    generateConfig,
    sleep,
    getTxOptions,
    txOptions
} = utils
const gasLimit = 6e6

// mainnet
const deployDeps = {
    wavax: {
        address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
        decimals: 18,
        feed: '0x0A77230d17318075983913bC2145DB16C7366156', // AVAX / USD Feed
        weight: 8e5 // .8e5
    },
    usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    proxyAdmin: '0xddf407237BDe4d36287Be4De79D65c57AefBf8da',
}

const deployParams = {
    setupContracts: {
        tradeFee: .00025 * 1e6, // insurance fund fee = .025%
        restrictedVUSD: false,
        setupAMM: false,
        testOracle: false,
        reserveToken: deployDeps.usdc,
        wavaxAddress: deployDeps.wavax.address,
        proxyAdmin: deployDeps.proxyAdmin
    }
}

async function main() {
    signers = await ethers.getSigners()
    deployParams.setupContracts.governance = signers[0].address

    let startBlock = await ethers.provider.getBlockNumber()
    console.log({ startBlock })

    txOptions.nonce = await signers[0].getTransactionCount()
    txOptions.gasLimit = gasLimit

    // 1. All the main contracts
    await setupContracts(deployParams.setupContracts)
    console.log({
        vammImpl: vammImpl.address,
        curveMath: curveMath.address,
        ammImpl: ammImpl.address
    })

    // 2. Collaterals
    console.log('setting up collateral tokens...')
    avax = await ethers.getContractAt('IERC20', deployDeps.wavax.address)

    console.log('setting aggregators...')
    await oracle.setAggregator(avax.address, deployDeps.wavax.feed, getTxOptions())

    console.log('whitelistCollateral...')
    await marginAccount.whitelistCollateral(avax.address, deployDeps.wavax.weight, getTxOptions())
    // console.log({ supportedAssets: await marginAccount.supportedAssets() })

    // 3. AMMs
    console.log('setup AMMs...')
    const ammOptions = {
        initialRate: 0,
        initialLiquidity: 0,
        fee: 5000000, // .05%
        ammState: 1 // Ignition
    }

    await setupAmm(
        governance,
        [ 'AVAX-PERP', avax.address, oracle.address, _1e18.mul(5) /* min size requirement */ ],
        Object.assign(ammOptions, { index: 0 })
    )

    console.log(utils.verification)
    await sleep(10)
    console.log(JSON.stringify(await generateConfig(leaderboard.address, marginAccountHelper.address, null, startBlock), null, 2))
}

async function preDeploy() {
    const ProxyAdmin = await ethers.getContractFactory('ProxyAdmin')
    const proxyAdmin = await ProxyAdmin.deploy()
    console.log({ proxyAdmin: proxyAdmin.address })
}

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
