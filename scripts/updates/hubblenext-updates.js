const utils = require('../../test/utils')

const {
    constants: { _1e6, _1e18 },
    sleep,
    getTxOptions,
    txOptions
} = utils

const config = {
    "OrderBook": "0x0300000000000000000000000000000000000069",
    "ClearingHouse": "0x0300000000000000000000000000000000000071",
    "HubbleViewer": "0x5F1f4Eb04a82b4D78D99b6eFd412e0B69653E75b",
    "MarginAccount": "0x0300000000000000000000000000000000000070",
    "Oracle": "0xC2116D4E4DAb6C6855D4510F3cb7006939F532f0",
    "InsuranceFund": "0x6039c0C0D2F4fb8657808b552BA5546D6047c677",
    "Registry": "0xE977c1bE1a6D00cF38e4F6C25FB8f0Ea86443F1C",
    "Leaderboard": "0x1e166a8b8722C414Fd4e6d0f08Af642F9C935c4d",
    "MarginAccountHelper": "0xD14c5E83936012FE510bc66252eF9F7F84F87E8e",
    "HubbleReferral": "0x0D1E59c330e7C7e0E3015f59f4908e5C6F27Df59",
    "vusd": "0x4de43dDbCF66cA36243BCB96b826c4bDdbd6AA89",
    "amms": [{
        "perp": "ETH-PERP",
        "address": "0xdEb5d9F965C5e7a512cd55F364ac2651E7528989",
        "underlying": "0x645CAfA2bb8385e4026223c13cBB580172939E48"
    }],
    "collateral": [{
        "name": "Hubble USD",
        "ticker": "hUSD",
        "decimals": "6",
        "weight": "1000000",
        "address": "0x4de43dDbCF66cA36243BCB96b826c4bDdbd6AA89"
    }]
}

async function mintNative() {
    const nativeMinter = await ethers.getContractAt('INativeMinter', '0x0200000000000000000000000000000000000001')
    // const to = '0x40ac7FaFeBc2D746E6679b8Da77F1bD9a5F1484f' // faucet
    // await nativeMinter.setEnabled(to)

    // await nativeMinter.mintNativeCoin(to, _1e18.mul(10e6))

    const maker = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    await nativeMinter.mintNativeCoin(maker, _1e18.mul(52000))

    const taker = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
    await nativeMinter.mintNativeCoin(taker, _1e18.mul(107000))
}

async function depositMargin() {
    ;([, alice, bob] = await ethers.getSigners())
    const maHelper = await ethers.getContractAt('MarginAccountHelper', '0xD14c5E83936012FE510bc66252eF9F7F84F87E8e')

    const amount = _1e6.mul(35000)
    // await maHelper.connect(alice).addVUSDMarginWithReserve(amount, { value: _1e18.mul(35000) })
    await maHelper.connect(bob).addVUSDMarginWithReserve(amount, { value: _1e18.mul(35000) })

    const marginAccount = await ethers.getContractAt('MarginAccount', '0x0300000000000000000000000000000000000070')
    console.log(await marginAccount.margin(0, alice.address))
    console.log(await marginAccount.margin(0, bob.address))
}

async function userPositions() {
    ;([, alice, bob] = await ethers.getSigners())
    const hubbleViewer = await ethers.getContractAt('HubbleViewer', '0x5F1f4Eb04a82b4D78D99b6eFd412e0B69653E75b')
    console.log(await hubbleViewer.userPositions(alice.address))
    console.log(await hubbleViewer.userPositions(bob.address))
}

async function fundingTime() {
    // const amm = await ethers.getContractAt('AMM', '0xdEb5d9F965C5e7a512cd55F364ac2651E7528989')
    // console.log(await amm.nextFundingTime())
    // console.log(await amm.getUnderlyingPrice())
    // console.log(await amm.getUnderlyingTwapPrice(3600))
    // console.log(await amm.getTwapPrice(3600))

    // const ch = await ethers.getContractAt('ClearingHouse', '0x0300000000000000000000000000000000000071')
    // console.log(await ch.getUnderlyingPrice())

    const orderbook = await ethers.getContractAt('OrderBook', '0x0300000000000000000000000000000000000069')
    const tx = await orderbook.estimateGas.settleFunding()
    console.log(tx)
    // console.log(await tx.wait())
}

async function updateAMM() {
    // let _admin = await ethers.provider.getStorageAt(amm.address, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103')
    // console.log(_admin)

    const amm = await ethers.getContractAt('AMM', '0xdEb5d9F965C5e7a512cd55F364ac2651E7528989')
    let _impl = await ethers.provider.getStorageAt(amm.address, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc')
    console.log({ _impl })

    const AMM = await ethers.getContractFactory('AMM')
    const ammImpl = await AMM.deploy(config.ClearingHouse)
    console.log({ newImpl: ammImpl.address })

    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', '0x8b9f4a2864d0fcded2411b1be92883fbcda1a7be')
    // console.log(await proxyAdmin.getProxyAdmin(amm.address))
    await proxyAdmin.upgrade(amm.address, ammImpl.address)
    _impl = await ethers.provider.getStorageAt(amm.address, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc')
    console.log({ _impl })
    await amm.setSpotPriceTwapInterval(60) // 1 minute
}

async function whitelistValidators() {
    const orderBook = await ethers.getContractAt('OrderBook', config.OrderBook)
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x9238Af6797e475d6e8B243cFA67e97782474e007'), true)
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x640ec0C55C185692eA97B1312FaD3a9CA37CfaD3'), true)
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x2ee2fBdaF888a942D5619456e0054178BffA0211'), true)
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x18D887e260b6E4416Ecb9C03476F511af416BB5B'), true)
}

async function setParams() {
    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    console.log(await Promise.all([
        ch.maintenanceMargin(),
        ch.minAllowableMargin(),
        ch.takerFee(),
        ch.makerFee(),
        ch.referralShare(),
        ch.tradingFeeDiscount(),
        ch.liquidationPenalty(),
    ]))
    await ch.setParams(
        '100000', // 0.1
        '200000', // 0.2
        '500', // .05%
        '-50', // -0.005%
        '50',
        '100',
        '50000'
    )
}

async function setupAMM() {
    signers = await ethers.getSigners()
    txOptions.nonce = await signers[0].getTransactionCount()
    txOptions.gasLimit = 5e6

    const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    const avax = await ERC20Mintable.deploy('avax', 'avax', 18, getTxOptions())
    governance = signers[0].address
    ;({ amm: avaxAmm } = await _setupAmm(
        governance,
        [ 'AVAX-PERP', avax.address, config.Oracle ],
        {
            initialRate: 15,
            testAmm: false,
            whitelist: true,
            minSize: utils.BigNumber.from(10).pow(17) // 0.1 AVAX
        }
    ))
    console.log({ address: avaxAmm.address, underlying: avax.address })
}

async function _setupAmm(governance, args, ammOptions, slowMode) {
    const { initialRate, testAmm, whitelist, minSize  } = ammOptions
    const AMM = await ethers.getContractFactory('AMM')
    const TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')

    let admin = await ethers.provider.getStorageAt(config.OrderBook, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103')

    const ammImpl = await AMM.deploy(config.ClearingHouse, getTxOptions())
    let constructorArguments = [
        ammImpl.address,
        ethers.utils.hexStripZeros(admin),
        ammImpl.interface.encodeFunctionData('initialize', args.concat([ minSize, governance ]))
    ]
    const ammProxy = await TransparentUpgradeableProxy.deploy(...constructorArguments, getTxOptions())
    await ammProxy.deployTransaction.wait()

    const amm = await ethers.getContractAt(testAmm ? 'TestAmm' : 'AMM', ammProxy.address)

    if (slowMode) {
        await sleep(5) // if the above txs aren't mined, read calls to amm fail
    }

    if (initialRate) {
        // amm.liftOff() needs the price for the underlying to be set
        // set index price within price spread
        const oracle = await ethers.getContractAt('TestOracle', config.Oracle)
        const underlyingAsset = await amm.underlyingAsset();
        await oracle.setUnderlyingTwapPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
        await oracle.setUnderlyingPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
    }

    if (whitelist) {
        const clearingHouse = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
        await clearingHouse.whitelistAmm(amm.address, getTxOptions())
        console.log('whitelisted amm', amm.address)
        // in newest version
        // const orderBook = await ethers.getContractAt('OrderBook', config.OrderBook)
        // await orderBook.initializeMinSize(minSize, getTxOptions())
    }

    return { amm }
}

mintNative()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
