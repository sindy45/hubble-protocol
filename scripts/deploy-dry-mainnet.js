const { expect } = require('chai')
const { ethers } = require('hardhat')
const utils = require('../test/utils')

const {
    constants: { _1e6, _1e8, _1e18 },
    setupContracts,
    setupRestrictedTestToken,
    setupAmm,
    generateConfig,
    sleep,
    getTxOptions,
    txOptions
} = utils
const gasLimit = 6e6

// fuji
const deployDeps = {
    wavax: {
        address: '0xd00ae08403B9bbb9124bB305C09058E32C39A48c',
        decimals: 18,
        feed: '0x5498BB86BC934c8D34FDA08E81D444153d0D06aD', // AVAX / USD Feed
        weight: 8e5 // .8e5
    },
    usdc: '0xbdab32601abbd79eff36bb23a4efebe334ffa09c',
    proxyAdmin: '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
}

const deployParams = {
    setupContracts: {
        tradeFee: .00025 * 1e6, // insurance fund fee = .025%
        restrictedVUSD: false,
        setupAMM: false,
        testOracle: false,
        reserveToken: deployDeps.usdc,
        proxyAdmin: deployDeps.proxyAdmin
    }
}

async function preDeploy() {
    const ProxyAdmin = await ethers.getContractFactory('ProxyAdmin')
    const proxyAdmin = await ProxyAdmin.deploy()
    console.log({ proxyAdmin: proxyAdmin.address })

    const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    const usdc = await ERC20Mintable.deploy('USD Coin', 'USDC', 6)
    console.log({ usdc: usdc.address })
}

async function main() {
    signers = await ethers.getSigners()
    deployParams.setupContracts.governance = signers[0].address

    // nonce can't be played around with in automine mode.
    // so if you run this script with --network local, uncomment the following 2 lines
    // await network.provider.send("evm_setAutomine", [false])
    // await network.provider.send("evm_setIntervalMining", [500])

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
    console.log(await marginAccount.supportedAssets())

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

    await sleep(1) // 10s on fuji
    console.log(JSON.stringify(await generateConfig(leaderboard.address, marginAccountHelper.address, null, startBlock), null, 2))
}

main()
// preDeploy()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
