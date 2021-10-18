const fs = require('fs')
const { BigNumber } = require('ethers')
const utils = require('../test/utils')

const { constants: { _1e18, _1e6 } } = utils
const _1e8 = BigNumber.from(10).pow(8)

const config = {
    marginAccount: '0x5977D567DD118D87062285a36a326A75dbdb3C6D',
    clearingHouse: '0xfe2239288Ab37b8bCCFb4ebD156463fb14EFC1e9',
    hubbleViewer: '0x5E8CF2Ab68DCED156378E714d81c2583869566dA',
    vusd: '0x93dA071feA5C808a4794975D814fb9AF7a05509B',
    oracle: '0x4c697464b051F46C7003c73071F7F52C39e6053c'
}

async function main() {
    signers = await ethers.getSigners()
    governance = signers[0].address
    const { marginAccount, clearingHouse, vusd, oracle } = await setupContracts(0.0005 * 1e6)

    // whitelist avax as collateral

    // const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    const avax = await ERC20Mintable.deploy('Hubble-Avax', 'hAVAX', 8)

    // avax = await ethers.getContractAt('ERC20Mintable', '0x8e8cecF1Ee553D72A60227102397E5128FF9f61F')
    await oracle.setAggregator(avax.address, '0x5498BB86BC934c8D34FDA08E81D444153d0D06aD') // AVAX / USD Feed
    await marginAccount.addCollateral(avax.address, 8e5) // weight = 0.8e6

    // setup another market
    // const btc = await ERC20Mintable.deploy('Bitcoin', 'BTC', 8)
    const btc = await ethers.getContractAt('ERC20Mintable', '0xFD7483C75c7C5eD7910c150A3FDf62cEa707E4dE')
    await sleep(2)
    await setupAmm(
        governance,
        [ registry.address, btc.address, 'BTC-Perp' ],
        57400, // initialRate => btc = $57400
        3000 // initialLiquidity = 3000 btc
    )

    const HubbleViewer = await ethers.getContractFactory('HubbleViewer')
    const hubbleViewer = await HubbleViewer.deploy(clearingHouse.address, marginAccount.address)

    const contracts = {
        marginAccount: marginAccount.address,
        clearingHouse: clearingHouse.address,
        hubbleViewer: hubbleViewer.address,
        vusd: vusd.address,
        avax: avax.address,
        oracle: oracle.address
    }
    console.log(contracts)
}

async function setupContracts(tradeFee) {
    // Vyper
    let abiAndBytecode = fs.readFileSync('./vyper/MoonMath.txt').toString().split('\n').filter(Boolean)
    const MoonMath = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Views.txt').toString().split('\n').filter(Boolean)
    const Views = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Swap.txt').toString().split('\n').filter(Boolean)
    Swap = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    moonMath = await MoonMath.deploy()
    await sleep(2)
    views = await Views.deploy(moonMath.address)

    // vyper deployment complete
    ;([ MarginAccountHelper, Registry, ERC20Mintable, TransparentUpgradeableProxy, ProxyAdmin ] = await Promise.all([
        ethers.getContractFactory('MarginAccountHelper'),
        ethers.getContractFactory('Registry'),
        ethers.getContractFactory('ERC20Mintable'),
        ethers.getContractFactory('TransparentUpgradeableProxy'),
        ethers.getContractFactory('ProxyAdmin')
    ]))

    // proxyAdmin = await ProxyAdmin.deploy()
    // weth = await ERC20Mintable.deploy('WETH', 'WETH', 18)
    // usdc = await ERC20Mintable.deploy('USD Coin', 'USDC', 6)
    // const vusd = await setupUpgradeableProxy('VUSD', proxyAdmin.address, [ governance ], [ usdc.address ])

    proxyAdmin = await ethers.getContractAt('ProxyAdmin', '0x6009fBD1f1026f233b0BA1f7dEcc016c0bB3201F')
    weth = await ethers.getContractAt('ERC20Mintable', '0xC1B33A334d34d72A503DfF50e97549503fFc760F')
    usdc = await ethers.getContractAt('ERC20Mintable', '0x9e978e428757eE34b188817d5Dca2d83ED1048C4')

    const vusd = await setupUpgradeableProxy('VUSD', proxyAdmin.address, [ governance ], [ usdc.address ])
    // vusd = await ethers.getContractAt('VUSD', '0x899BFb3479AA6d32D85E1Fd4dbba6E9A814cF60D')

    oracle = await setupUpgradeableProxy('Oracle', proxyAdmin.address, [ governance ])
    await sleep(2)
    await oracle.setStablePrice(vusd.address, 1e6) // $1
    await sleep(2)

    marginAccount = await setupUpgradeableProxy('MarginAccount', proxyAdmin.address, [ governance, vusd.address ])
    await sleep(2)
    marginAccountHelper = await MarginAccountHelper.deploy(marginAccount.address, vusd.address)
    await sleep(2)
    insuranceFund = await setupUpgradeableProxy('InsuranceFund', proxyAdmin.address, [ governance ])
    await sleep(2)

    clearingHouse = await setupUpgradeableProxy(
        'ClearingHouse',
        proxyAdmin.address,
        [
            governance,
            insuranceFund.address,
            marginAccount.address,
            vusd.address,
            0.1 * 1e6 /* 10% maintenance margin */,
            tradeFee,
            0.05 * 1e6, // liquidationPenalty = 5%])
        ]
    )
    await sleep(2)
    await vusd.grantRole(await vusd.MINTER_ROLE(), clearingHouse.address)
    await sleep(2)

    registry = await Registry.deploy(oracle.address, clearingHouse.address, insuranceFund.address, marginAccount.address, vusd.address)
    await sleep(2)

    const { amm, vamm } = await setupAmm(
        governance,
        [ registry.address, weth.address, 'ETH-Perp' ],
        3500, // initialRate,
        50000 // initialLiquidity
    )

    const liquidationIncentive = 5e4 // 5% = .05 scaled 6 decimals
    await marginAccount.syncDeps(registry.address, liquidationIncentive),
    await insuranceFund.syncDeps(registry.address)
    return { swap: vamm, registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, weth, oracle, insuranceFund }
}

async function setupUpgradeableProxy(contract, admin, initArgs, deployArgs) {
    console.log({
        setupUpgradeableProxy: contract,
        initArgs,
        deployArgs
    })
    const factory = await ethers.getContractFactory(contract)
    let impl
    if (deployArgs) {
        impl = await factory.deploy(...deployArgs)
    } else {
        impl = await factory.deploy()
    }
    await sleep(3)
    const proxy = await TransparentUpgradeableProxy.deploy(
        impl.address,
        admin,
        initArgs
            ? impl.interface.encodeFunctionData(
                contract === 'InsuranceFund' || contract === 'VUSD' ? 'init' : 'initialize',
                initArgs
            )
            : '0x'
    )
    console.log(`${contract}: ${proxy.address}`)
    return ethers.getContractAt(contract, proxy.address)
}

async function setupAmm(governance, args, initialRate, initialLiquidity, _pause = false) {
    const vamm = await Swap.deploy(
        governance, // owner
        moonMath.address, // math
        views.address, // views
        54000, // A
        '3500000000000000', // gamma
        0, 0, 0, 0, // mid_fee, out_fee, allowed_extra_profit, fee_gamma
        '490000000000000', // adjustment_step
        0, // admin_fee
        600, // ma_half_time
        [_1e18.mul(40000) /* btc initial rate */, _1e18.mul(initialRate)]
    )
    await sleep(2)
    const amm = await setupUpgradeableProxy('AMM', proxyAdmin.address, args.concat([ vamm.address, governance ]))
    if (!_pause) {
        await amm.togglePause(_pause)
        await sleep(2)
    }
    await vamm.setAMM(amm.address)
    await sleep(2)

    initialLiquidity = _1e18.mul(initialLiquidity)
    await vamm.add_liquidity([
        initialLiquidity.mul(initialRate), // USD
        _1e6.mul(100).mul(25), // 25 btc - value not used
        initialLiquidity
    ], 0)
    await clearingHouse.whitelistAmm(amm.address)
    return { amm, vamm }
}

function sleep(s) {
    return new Promise(resolve => setTimeout(resolve, s * 1000));
}

async function poke() {
    // let clearingHouse = await ethers.getContractAt('ClearingHouse', config.clearingHouse)
    // let marginAccount = await ethers.getContractAt('MarginAccount', config.marginAccount)
    // let vusd = await ethers.getContractAt('VUSD', config.vusd)
    // let oracle = await ethers.getContractAt('Oracle', config.oracle)
    // let ethAmm = await ethers.getContractAt('AMM', '0x74583fEbc73B8cfEAD50107C49F868301699641E')
    // let btcAmm = await ethers.getContractAt('AMM', '0xCF9541901625fd348eDe299309597cB36f4e4328')
    const HubbleViewer = await ethers.getContractFactory('HubbleViewer')
    const hubbleViewer = await HubbleViewer.deploy(config.clearingHouse, config.marginAccount)
    console.log(hubbleViewer.address)
}

async function updateImpl(contract, tupAddy, deployArgs) {
    const factory = await ethers.getContractFactory(contract)
    let impl
    if (deployArgs) {
        impl = await factory.deploy(...deployArgs)
    } else {
        impl = await factory.deploy()
    }
    await sleep(2)

    const proxyAdmin = await ethers.getContractAt('ProxyAdmin', '0x6009fBD1f1026f233b0BA1f7dEcc016c0bB3201F')
    // console.log(await proxyAdmin.getProxyAdmin(tupAddy))
    console.log(await proxyAdmin.getProxyImplementation(tupAddy))
    await proxyAdmin.upgrade(tupAddy, impl.address)
    await sleep(2)
    console.log(await proxyAdmin.getProxyImplementation(tupAddy))
}

// main()
// updateImpl('MarginAccount', '0x5977D567DD118D87062285a36a326A75dbdb3C6D')
poke()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
