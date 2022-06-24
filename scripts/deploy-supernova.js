const { expect } = require('chai')
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

async function main() {
    signers = await ethers.getSigners()
    governance = signers[0].address

    // nonce can't be played around with in automine mode.
    // so if you run this script with --network local, uncomment the following 2 lines
    // await network.provider.send("evm_setAutomine", [false])
    // await network.provider.send("evm_setIntervalMining", [500])

    txOptions.nonce = await signers[0].getTransactionCount()
    txOptions.gasLimit = gasLimit

    // 1. All the main contracts
    await setupContracts({ governance, setupAMM: false, testOracle: false })
    console.log({ vammImpl: vammImpl.address })
    console.log({ curveMath: curveMath.address })
    console.log({ ammImpl: ammImpl.address })

    // 2. Collaterals
    console.log('setting up collateral tokens...')
    avax = await setupRestrictedTestToken('Hubble AVAX', 'hAVAX', 18)
    weth = await setupRestrictedTestToken('Hubble Ether', 'hWETH', 18)
    btc = await setupRestrictedTestToken('Hubble BTC', 'hWBTC', 8)

    console.log('setting aggregators...')
    await oracle.setAggregator(avax.address, '0x5498BB86BC934c8D34FDA08E81D444153d0D06aD', getTxOptions()) // AVAX / USD Feed
    await oracle.setAggregator(weth.address, '0x86d67c3D38D2bCeE722E601025C25a575021c6EA', getTxOptions()) // ETH / USD Feed
    await oracle.setAggregator(btc.address, '0x31CF013A08c6Ac228C94551d535d5BAfE19c602a', getTxOptions()) // BTC / USD Feed

    console.log('whitelistCollateral...')
    await marginAccount.whitelistCollateral(avax.address, 8e5, getTxOptions()) // weight = 0.8e6
    await marginAccount.whitelistCollateral(weth.address, 8e5, getTxOptions())
    await marginAccount.whitelistCollateral(btc.address, 8e5, getTxOptions())

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
        [ 'AVAX-PERP', avax.address, oracle.address ],
        Object.assign(ammOptions, { index: 0 })
    )

    await setupAmm(
        governance,
        [ 'ETH-PERP', weth.address, oracle.address ],
        Object.assign(ammOptions, { index: 1 })
    )

    await setupAmm(
        governance,
        [ 'BTC-PERP', btc.address, oracle.address ],
        Object.assign(ammOptions, { index: 2 })
    )

    // 4. Setup Faucet
    console.log('setting up faucet...')
    faucet = '0x40ac7FaFeBc2D746E6679b8Da77F1bD9a5F1484f'

    // const Executor = await ethers.getContractFactory('Executor')
    // executor = await Executor.deploy(getTxOptions())

    executor = await ethers.getContractAt('Executor', '0xC0BCb6F17Ef0Dd784dcb5a12Bb9Ea9253C1dd998')

    await sleep(10) // 10s on fuji
    console.log(JSON.stringify(await generateConfig(leaderboard.address, executor.address), null, 2))

    // Print test tokens etc
    // mint test tokens to faucet
    airdropAmounts = {
        vusd: _1e6.mul(25000),
        avax: _1e18.mul(100),
        weth: _1e18.mul(3),
        btc: _1e8.mul(3).div(10)
    }
    const users = 3000
    const DEFAULT_ADMIN_ROLE = '0x' + '0'.repeat(64)
    const TRANSFER_ROLE = ethers.utils.id('TRANSFER_ROLE')
    await Promise.all([
        // executor.grantRole(DEFAULT_ADMIN_ROLE, faucet, getTxOptions()),
        vusd.grantRole(TRANSFER_ROLE, executor.address, getTxOptions()),
        avax.grantRole(TRANSFER_ROLE, executor.address, getTxOptions()),
        weth.grantRole(TRANSFER_ROLE, executor.address, getTxOptions()),
        btc.grantRole(TRANSFER_ROLE, executor.address, getTxOptions()),
        vusd.mint(executor.address, airdropAmounts.vusd.mul(users), getTxOptions()),
        avax.mint(executor.address, airdropAmounts.avax.mul(users), getTxOptions()),
        weth.mint(executor.address, airdropAmounts.weth.mul(users), getTxOptions()),
        btc.mint(executor.address, airdropAmounts.btc.mul(users), getTxOptions()),
    ])

    // await testFaucet(signers[1].address)
}

async function testFaucet(recipient) {
    const tx = [
        [vusd.address, avax.address, weth.address, btc.address],
        [
          vusd.interface.encodeFunctionData("transfer", [recipient,airdropAmounts.vusd]),
          avax.interface.encodeFunctionData("transfer", [recipient,airdropAmounts.avax]),
          weth.interface.encodeFunctionData("transfer", [recipient, airdropAmounts.weth]),
          btc.interface.encodeFunctionData("transfer", [recipient, airdropAmounts.btc]),
        ],
    ];
    await utils.impersonateAcccount(faucet)
    await web3.eth.sendTransaction({ from: signers[0].address, to: faucet, value: _1e18 })
    await executor.connect(ethers.provider.getSigner(faucet)).execute(...tx)

    await sleep(1)
    expect(await vusd.balanceOf(recipient)).to.eq(airdropAmounts.vusd)
    expect(await avax.balanceOf(recipient)).to.eq(airdropAmounts.avax)
    expect(await weth.balanceOf(recipient)).to.eq(airdropAmounts.weth)
    expect(await btc.balanceOf(recipient)).to.eq(airdropAmounts.btc)
}

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
