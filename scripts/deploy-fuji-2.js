const fs = require('fs')
const { BigNumber } = require('ethers')
const utils = require('../test/utils')

const { constants: { _1e18, _1e6 } } = utils
const _1e8 = BigNumber.from(10).pow(8)

const config = {
    marginAccount: '0x21CA385a974a201c2dB26Ce1616F88F0365EDa1e',
    clearingHouse: '0xf75ffAa1A468dDE621A2e6e44e2e679fEA5Ca49D',
    hubbleViewer: '0x5c9aeCdE2955F3086cbA9f8dEA0310f1B37C4F99',
    vusd: '0x9082bB5219b79017eDdd4e775A6107992e6b001f',
    avax: '0x64cBEAc5aAaa458ef849cf4febC75c02a2340EaB',
    oracle: '0x30e90Fb28E1071842bF2Ea4F31B4ce031b195603',
    insuranceFund: '0x2dd83b43366595A71C1Fcb8C10f40f42f306EbCa',
    weth: '0xC1B33A334d34d72A503DfF50e97549503fFc760F',
    proxyAdmin: '0x097faEAa93bAEd16BFA7abCa4A69854f4Cf86dCD',
    ethAmm: '0xf8A6ac7fb0fBAB8db7ACE083746207dD7EC8bFB6',
    btcAmm: '0x8C87DB533b62d13efF20681c84c50ca4EDab2e3a'
}

async function main() {
    signers = await ethers.getSigners()
    governance = signers[0].address

    const { marginAccount, clearingHouse, vusd, oracle, hubbleViewer } = await setupContracts(0.0005 * 1e6)

    // whitelist avax as collateral

    // const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    const avax = await ERC20Mintable.deploy('Hubble-Avax', 'hAVAX', 8)

    await oracle.setAggregator(avax.address, '0x5498BB86BC934c8D34FDA08E81D444153d0D06aD') // AVAX / USD Feed
    await marginAccount.whitelistCollateral(avax.address, 8e5) // weight = 0.8e6

    // setup another market
    // const btc = await ERC20Mintable.deploy('Bitcoin', 'BTC', 8)
    const btc = await ethers.getContractAt('ERC20Mintable', '0xFD7483C75c7C5eD7910c150A3FDf62cEa707E4dE')
    await sleep(2)
    await setupAmm(
        governance,
        [ registry.address, btc.address, 'BTC-Perp' ],
        57400, // initialRate => btc = $57400
    )

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

async function setupContracts(tradeFee = DEFAULT_TRADE_FEE, options = { addLiquidity: true }) {
    // Vyper
    let abiAndBytecode = fs.readFileSync('./vyper/MoonMath.txt').toString().split('\n').filter(Boolean)
    const MoonMath = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Views.txt').toString().split('\n').filter(Boolean)
    const Views = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    vammAbiAndBytecode = fs.readFileSync('./vyper/Swap.txt').toString().split('\n').filter(Boolean)
    Swap = new ethers.ContractFactory(JSON.parse(vammAbiAndBytecode[0]), vammAbiAndBytecode[1], signers[0])

    moonMath = await MoonMath.deploy()
    await sleep(2)
    views = await Views.deploy(moonMath.address)
    // vyper deployment complete
    ;([ MarginAccountHelper, Registry, ERC20Mintable, MinimalForwarder, TransparentUpgradeableProxy, ProxyAdmin ] = await Promise.all([
        ethers.getContractFactory('MarginAccountHelper'),
        ethers.getContractFactory('Registry'),
        ethers.getContractFactory('ERC20Mintable'),
        ethers.getContractFactory('MinimalForwarder'),
        ethers.getContractFactory('TransparentUpgradeableProxy'),
        ethers.getContractFactory('ProxyAdmin')
    ]))

    proxyAdmin = await ProxyAdmin.deploy()
    console.log('proxyAdmin: ', proxyAdmin.address)
    weth = await ethers.getContractAt('ERC20Mintable', '0xC1B33A334d34d72A503DfF50e97549503fFc760F')
    usdc = await ethers.getContractAt('ERC20Mintable', '0x9e978e428757eE34b188817d5Dca2d83ED1048C4')

    const vusd = await setupUpgradeableProxy('VUSD', proxyAdmin.address, [ governance ], [ usdc.address ])

    oracle = await setupUpgradeableProxy('Oracle', proxyAdmin.address, [ governance ])
    await sleep(2)
    await oracle.setStablePrice(vusd.address, 1e6) // $1
    await sleep(2)

    forwarder = await MinimalForwarder.deploy()
    await forwarder.intialize()
    await sleep(2)

    marginAccount = await setupUpgradeableProxy('MarginAccount', proxyAdmin.address, [ forwarder.address, governance, vusd.address ])
    await sleep(2)
    marginAccountHelper = await MarginAccountHelper.deploy(marginAccount.address, vusd.address)
    await sleep(2)
    insuranceFund = await setupUpgradeableProxy('InsuranceFund', proxyAdmin.address, [ governance ])
    await sleep(2)

    clearingHouse = await setupUpgradeableProxy(
        'ClearingHouse',
        proxyAdmin.address,
        [
            forwarder.address,
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
    const liquidationIncentive = 5e4 // 5% = .05 scaled 6 decimals
    await marginAccount.syncDeps(registry.address, liquidationIncentive),
    await insuranceFund.syncDeps(registry.address)
    await sleep(2)

    vammImpl = await Swap.deploy()
    ;({ amm, vamm } = await setupAmm(
        governance,
        [ registry.address, weth.address, 'ETH-Perp' ],
        1000, // initialRate,
    ))

    const HubbleViewer = await ethers.getContractFactory('HubbleViewer')
    const hubbleViewer = await HubbleViewer.deploy(clearingHouse.address, marginAccount.address)

    return {
        swap: vamm,
        amm,
        registry,
        marginAccount,
        marginAccountHelper,
        clearingHouse,
        hubbleViewer,
        vusd,
        usdc,
        weth,
        oracle,
        insuranceFund,
        forwarder,
        tradeFee
    }
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

async function setupAmm(governance, args, initialRate, _pause = false, index = 0) {
    const VammProxy = await TransparentUpgradeableProxy.deploy(
        vammImpl.address,
        proxyAdmin.address,
        vammImpl.interface.encodeFunctionData('initialize', [
            governance, // owner
            moonMath.address, // math
            views.address, // views
            54000, // A
            '3500000000000000', // gamma
            11000000, 0, 0, 0, // mid_fee = 0.11%, out_fee, allowed_extra_profit, fee_gamma
            '490000000000000', // adjustment_step
            0, // admin_fee
            600, // ma_half_time
            _1e18.mul(initialRate)
        ])
    )
    await sleep(2)

    const vamm = new ethers.Contract(VammProxy.address, JSON.parse(vammAbiAndBytecode[0]), signers[0])
    const amm = await setupUpgradeableProxy('AMM', proxyAdmin.address, args.concat([ vamm.address, governance ]))
    if (!_pause) {
        await amm.togglePause(_pause)
        await sleep(2)
    }
    await vamm.setAMM(amm.address)
    await sleep(2)

    await clearingHouse.whitelistAmm(amm.address)

    return { amm, vamm }
}

function sleep(s) {
    return new Promise(resolve => setTimeout(resolve, s * 1000));
}

async function poke() {
    // let clearingHouse = await ethers.getContractAt('ClearingHouse', config.clearingHouse)
    // let marginAccount = await ethers.getContractAt('MarginAccount', config.marginAccount)
    // let registry = await ethers.getContractAt('Registry', '0x7a7ec21c6941088c280391d1c5e475a01f2a591e')
    let vusd = await ethers.getContractAt('VUSD', config.vusd)
    // let oracle = await ethers.getContractAt('Oracle', config.oracle)
    // let ethAmm = await ethers.getContractAt('AMM', '0x74583fEbc73B8cfEAD50107C49F868301699641E')
    // let btcAmm = await ethers.getContractAt('AMM', '0xCF9541901625fd348eDe299309597cB36f4e4328')
    // const HubbleViewer = await ethers.getContractFactory('HubbleViewer')
    // const hubbleViewer = await HubbleViewer.deploy(config.clearingHouse, config.marginAccount)
    // console.log(await registry.oracle())
    // console.log(await registry.clearingHouse())
    // console.log(await registry.insuranceFund())
    // console.log(await registry.marginAccount())
    // console.log(await registry.vusd())
    await vusd.mint('0xc3b2CB4d9500ef85C3104645fed19B1DfFF471bc', _1e6.mul(_1e6).mul(10))
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

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
