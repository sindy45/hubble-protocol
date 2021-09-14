const { expect } = require('chai');

const fs = require('fs')
const { BigNumber } = require('ethers')

const _1e6 = BigNumber.from(10).pow(6)
const _1e18 = ethers.constants.WeiPerEther
const ZERO = BigNumber.from(0)

const DEFAULT_TRADE_FEE = 0.0005 * 1e6 /* 0.05% */

function log(position, notionalPosition, unrealizedPnl, marginFraction) {
    console.log({
        size: position.size.toString(),
        openNotional: position.openNotional.toString(),
        notionalPosition: notionalPosition.toString(),
        unrealizedPnl: unrealizedPnl.toString(),
        marginFraction: marginFraction.toString()
    })
}

async function setupContracts(tradeFee = DEFAULT_TRADE_FEE) {
    let abiAndBytecode = fs.readFileSync('./vyper/MoonMath.txt').toString().split('\n').filter(Boolean)
    const MoonMath = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Views.txt').toString().split('\n').filter(Boolean)
    const Views = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Swap.txt').toString().split('\n').filter(Boolean)
    Swap = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    ;([ ClearingHouse, AMM, MarginAccount, MarginAccountHelper, VUSD, Oracle, Registry ] = await Promise.all([
        ethers.getContractFactory('ClearingHouse'),
        ethers.getContractFactory('AMM'),
        ethers.getContractFactory('MarginAccount'),
        ethers.getContractFactory('MarginAccountHelper'),
        ethers.getContractFactory('VUSD'),
        ethers.getContractFactory('Oracle'),
        ethers.getContractFactory('Registry'),
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
        _1e18.mul(_1e6), // 1m USDT
        _1e6.mul(100).mul(25), // 25 btc
        _1e18.mul(1000) // 1000 eth
    ], 0)
    // await swap.exchange(0, 2, '100000000', 0)
    ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    usdc = await ERC20Mintable.deploy('usdc', 'usdc', 6)
    const vusd = await VUSD.deploy(usdc.address)
    oracle = await Oracle.deploy()
    await oracle.setPrice(vusd.address, 1e6) // $1
    registry = await Registry.deploy(oracle.address)

    marginAccount = await MarginAccount.deploy(vusd.address, oracle.address)
    marginAccountHelper = await MarginAccountHelper.deploy(marginAccount.address, vusd.address)
    clearingHouse = await ClearingHouse.deploy(
        marginAccount.address,
        0.1 * 1e6 /* 3% maintenance margin */,
        tradeFee,
        0.05 * 1e6, // liquidationPenalty = 5%
        vusd.address
    )
    await vusd.grantRole(await vusd.MINTER_ROLE(), clearingHouse.address)
    await vusd.grantRole(await vusd.MINTER_ROLE(), alice)
    await marginAccount.setClearingHouse(clearingHouse.address)

    // whitelistAmm
    weth = await ERC20Mintable.deploy('weth', 'weth', 18)
    amm = await AMM.deploy(clearingHouse.address, swap.address, weth.address, registry.address)
    await clearingHouse.whitelistAmm(amm.address)

    return { swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, weth, oracle }
}

async function filterEvent(tx, name) {
    const { events } = await tx.wait()
    return events.find(e => e.event == name)
}

async function getTradeDetails(tx, tradeFee = DEFAULT_TRADE_FEE) {
    const positionOpenEvent = await filterEvent(tx, 'PositionOpened')
    return {
        quoteAsset: positionOpenEvent.args.quoteAsset,
        fee: positionOpenEvent.args.quoteAsset.mul(tradeFee).div(_1e6)
    }
}

async function assertions(amm, clearingHouse, trader, vals, shouldLog) {
    const position = await amm.positions(trader)
    const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(trader)
    const marginFraction = await clearingHouse.getMarginFraction(trader)

    if (shouldLog) {
        log(position, notionalPosition, unrealizedPnl, marginFraction)
    }

    if (vals.size != null) {
        expect(position.size).to.eq(vals.size)
    }
    if (vals.openNotional != null) {
        expect(position.openNotional).to.eq(vals.openNotional)
    }
    if (vals.notionalPosition != null) {
        expect(notionalPosition).to.eq(vals.notionalPosition)
    }
    if (vals.unrealizedPnl != null) {
        expect(unrealizedPnl).to.eq(vals.unrealizedPnl)
    }
    if (vals.marginFractionNumerator != null) {
        expect(marginFraction).to.eq(vals.marginFractionNumerator.mul(_1e6).div(notionalPosition))
    }
    if (vals.marginFraction != null) {
        expect(marginFraction).to.eq(vals.marginFraction)
    }

    return { position, notionalPosition, unrealizedPnl, marginFraction }
}

module.exports = {
    constants: { _1e6, _1e18, ZERO },
    log, setupContracts, filterEvent, getTradeDetails, assertions
}
