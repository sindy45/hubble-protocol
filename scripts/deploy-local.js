const fs = require('fs')
const { constants: { _1e6, _1e18, ZERO } } = require('../test/utils')

const DEFAULT_TRADE_FEE = 0.0005 * 1e6 /* 0.05% */

async function setupContracts(tradeFee = DEFAULT_TRADE_FEE) {
    const signers = await ethers.getSigners()

    let abiAndBytecode = fs.readFileSync('./vyper/MoonMath.txt').toString().split('\n').filter(Boolean)
    const MoonMath = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Views.txt').toString().split('\n').filter(Boolean)
    const Views = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Swap.txt').toString().split('\n').filter(Boolean)
    Swap = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    ;([ ClearingHouse, AMM, MarginAccount, MarginAccountHelper, VUSD, Oracle, Registry, InsuranceFund, ERC20Mintable ] = await Promise.all([
        ethers.getContractFactory('ClearingHouse'),
        ethers.getContractFactory('AMM'),
        ethers.getContractFactory('MarginAccount'),
        ethers.getContractFactory('MarginAccountHelper'),
        ethers.getContractFactory('VUSD'),
        ethers.getContractFactory('Oracle'),
        ethers.getContractFactory('Registry'),
        ethers.getContractFactory('InsuranceFund'),
        ethers.getContractFactory('ERC20Mintable')
    ]))
    moonMath = await MoonMath.deploy()
    views = await Views.deploy(moonMath.address)

    swap = await Swap.deploy(
        "0xbabe61887f1de2713c6f97e567623453d3c79f67",
        "0xbabe61887f1de2713c6f97e567623453d3c79f67",
        moonMath.address,
        views.address,
        3645,
        "69999999999999",
        0,
        0,
        "2800000000000000",
        0,
        "1500000000000000",
        0,
        600,
        [_1e18.mul(40000) /* btc initial rate */, _1e18.mul(1000) /* eth initial rate */]
    )
    usdc = await ERC20Mintable.deploy('usdc', 'usdc', 6)
    const vusd = await VUSD.deploy(usdc.address)
    oracle = await Oracle.deploy()
    await oracle.setPrice(vusd.address, 1e6) // $1

    marginAccount = await MarginAccount.deploy()
    marginAccountHelper = await MarginAccountHelper.deploy(marginAccount.address, vusd.address)
    clearingHouse = await ClearingHouse.deploy(
        marginAccount.address,
        0.1 * 1e6 /* 3% maintenance margin */,
        tradeFee,
        0.05 * 1e6, // liquidationPenalty = 5%
        vusd.address
    )
    await vusd.grantRole(await vusd.MINTER_ROLE(), clearingHouse.address)

    insuranceFund = await InsuranceFund.deploy('if', 'if')
    registry = await Registry.deploy(oracle.address, clearingHouse.address, insuranceFund.address, marginAccount.address, vusd.address)
    weth = await ERC20Mintable.deploy('weth', 'weth', 18)
    amm = await AMM.deploy(clearingHouse.address, swap.address, weth.address, registry.address)

    await swap.setAMM(amm.address)
    await Promise.all([
        clearingHouse.whitelistAmm(amm.address),
        marginAccount.initialize(registry.address),
        insuranceFund.syncDeps(registry.address),
        swap.add_liquidity([
            _1e18.mul(_1e6), // 1m USDT
            _1e6.mul(100).mul(25), // 25 btc
            _1e18.mul(1000) // 1000 eth
        ], 0)
    ])

    // provide some vusd balance to signers[1]
    const initialVusdAmount = _1e6.mul(1000)
    await usdc.mint(signers[1].address, initialVusdAmount)
    await usdc.connect(signers[1]).approve(vusd.address, initialVusdAmount)
    await vusd.connect(signers[1]).mintWithReserve(signers[1].address, initialVusdAmount)

    const contracts = {
        vamm: swap.address,
        amm: amm.address,
        marginAccount: marginAccount.address,
        marginAccountHelper: marginAccountHelper.address,
        clearingHouse: clearingHouse.address,
        insuranceFund: insuranceFund.address,
        vusd: vusd.address,
        usdc: usdc.address,
        weth: weth.address
    }
    console.log(contracts)
}

setupContracts()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
