const fs = require('fs')
const { BigNumber } = require('ethers')
const utils = require('../test/utils')

const { constants: { _1e18, _1e6 } } = utils
const _1e8 = BigNumber.from(10).pow(8)

const participants = [
    '0x36E24b66Cb2a474D20B33eb9EA49c3c39f1b3A90' //  atvanguard
]

async function main() {
    signers = await ethers.getSigners()
    alice = signers[0].address

    const { marginAccount, clearingHouse, vusd, usdc, oracle } = await setupContracts(0.0005 * 1e6)

    // provide some vusd to participants[0]
    const initialVusdAmount = _1e6.mul(1e4)
    await vusd.mint(participants[0], initialVusdAmount)
    // await usdc.connect(participants[0]).approve(vusd.address, initialVusdAmount)
    // await vusd.connect(participants[0]).mintWithReserve(participants[0], initialVusdAmount)

    // whitelist avax as collateral
    const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    const avax = await ERC20Mintable.deploy('Avalanche', 'AVAX', 8)
    await sleep(2)
    await oracle.setAggregator(avax.address, '0x5498BB86BC934c8D34FDA08E81D444153d0D06aD')
    await sleep(2)
    await marginAccount.addCollateral(avax.address, 8e5) // weight = 0.8e6
    await sleep(2)
    await avax.mint(participants[0], _1e8.mul(2e3)) // 2000 avax

    // setup another market
    const btc = await ERC20Mintable.deploy('Bitcoin', 'BTC', 8)
    await sleep(2)
    await utils.setupAmm(
        [ alice, registry.address, btc.address, 'BTC-Perp' ],
        55000, // initialRate => btc = $55000
        4000 // initialLiquidity = 4000 btc
    )

    const HubbleViewer = await ethers.getContractFactory('HubbleViewer')
    const hubbleViewer = await HubbleViewer.deploy(clearingHouse.address)

    const contracts = {
        marginAccount: marginAccount.address,
        clearingHouse: clearingHouse.address,
        hubbleViewer: hubbleViewer.address,
        vusd: vusd.address,
        oracle: oracle.address
    }
    console.log(contracts)
}

async function setupContracts(tradeFee) {
    governance = alice

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

    proxyAdmin = await ProxyAdmin.deploy()
    await sleep(2)
    usdc = await ERC20Mintable.deploy('USD Coin', 'USDC', 6)
    await sleep(2)
    weth = await ERC20Mintable.deploy('WETH', 'WETH', 18)
    await sleep(2)

    const vusd = await setupUpgradeableProxy('VUSD', proxyAdmin.address, [ governance ], [ usdc.address ])
    await sleep(2)

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
            alice,
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
        [ governance, registry.address, weth.address, 'ETH-Perp' ],
        3580, // initialRate,
        60000 // initialLiquidity
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
    await sleep(2)
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

async function setupAmm(args, initialRate, initialLiquidity, _pause = false) {
    const vamm = await Swap.deploy(
        "0xbabe61887f1de2713c6f97e567623453d3c79f67", // owner
        "0xbabe61887f1de2713c6f97e567623453d3c79f67", // admin_fee_receiver
        moonMath.address, // math
        views.address, // views
        54000, // A
        "3500000000000000", // gamma
        0,
        0,
        "0",
        0,
        "490000000000000", // adjustment_step
        0,
        600, // ma_half_time
        [_1e18.mul(40000) /* btc initial rate */, _1e18.mul(initialRate)]
    )
    const amm = await setupUpgradeableProxy('AMM', proxyAdmin.address, args.concat([vamm.address]))
    if (!_pause) {
        await amm.togglePause(_pause)
    }
    await vamm.setAMM(amm.address)

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

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
