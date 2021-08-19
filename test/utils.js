const fs = require('fs')
const { BigNumber } = require('ethers')

const _1e6 = BigNumber.from(10).pow(6)
const _1e18 = ethers.constants.WeiPerEther
const ZERO = BigNumber.from(0)

function log(position, notionalPosition, unrealizedPnl, marginFraction) {
    // console.log({
    //     size: position.size.toString(),
    //     openNotional: position.openNotional.toString(),
    //     notionalPosition: notionalPosition.toString(),
    //     unrealizedPnl: unrealizedPnl.toString(),
    //     marginFraction: marginFraction.toString()
    // })
}

async function setupContracts(tradeFee = 0.0005 * 1e6 /* 0.05% */) {
    let abiAndBytecode = fs.readFileSync('./vyper/MoonMath.txt').toString().split('\n').filter(Boolean)
    const MoonMath = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Views.txt').toString().split('\n').filter(Boolean)
    const Views = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Swap.txt').toString().split('\n').filter(Boolean)
    Swap = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    ;([ ClearingHouse, AMM, MarginAccount, VUSD ] = await Promise.all([
        ethers.getContractFactory('ClearingHouse'),
        ethers.getContractFactory('AMM'),
        ethers.getContractFactory('MarginAccount'),
        ethers.getContractFactory('VUSD')
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
    await swap.add_liquidity([
        _1e6.mul(_1e6), // 1m USDT
        _1e6.mul(100).mul(25), // 25 btc
        _1e18.mul(1000) // 1000 eth
    ], 0)
    // await swap.add_liquidity([
    //     _1e6.mul(_1e6).mul(_1e6), // 1m USDT
    //     _1e6.mul(100).mul(25), // 25 btc
    //     _1e18.mul(1000).mul(1000) // 1000 eth
    // ], 0)
    // await swap.exchange(0, 2, '100000000', 0)
    const vUSD = await VUSD.deploy()
    ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    usdc = await ERC20Mintable.deploy('usdc', 'usdc', 6)

    marginAccount = await MarginAccount.deploy(vUSD.address, usdc.address)
    clearingHouse = await ClearingHouse.deploy(
        marginAccount.address,
        0.03 * 1e6 /* 3% maintenance margin */,
        tradeFee
    )
    await marginAccount.setClearingHouse(clearingHouse.address)

    // whitelistAmm
    amm = await AMM.deploy(clearingHouse.address, swap.address)
    await clearingHouse.whitelistAmm(amm.address)

    return { swap, marginAccount, clearingHouse, amm, vUSD, usdc }
}

async function filterEvent(tx, name) {
    const { events } = await tx.wait()
    return events.find(e => e.event == name)
}

module.exports = {
    constants: { _1e6, _1e18, ZERO },
    log, setupContracts, filterEvent
}
