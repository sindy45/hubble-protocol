const { expect } = require('chai');

const fs = require('fs')
const { BigNumber } = require('ethers')

const _1e6 = BigNumber.from(10).pow(6)
const _1e12 = BigNumber.from(10).pow(12)
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
        [_1e18.mul(40000) /* btc initial rate */, _1e18.mul(1000) /* eth initial rate */]
    )
    usdc = await ERC20Mintable.deploy('usdc', 'usdc', 6)
    const vusd = await VUSD.deploy(usdc.address)
    oracle = await Oracle.deploy()
    await oracle.setPrice(vusd.address, 1e6) // $1

    marginAccount = await MarginAccount.deploy()
    marginAccountHelper = await MarginAccountHelper.deploy(marginAccount.address, vusd.address)
    insuranceFund = await InsuranceFund.deploy('if', 'if')

    clearingHouse = await ClearingHouse.deploy(
        insuranceFund.address,
        marginAccount.address,
        vusd.address,
        0.1 * 1e6 /* 3% maintenance margin */,
        tradeFee,
        0.05 * 1e6, // liquidationPenalty = 5%
    )
    await vusd.grantRole(await vusd.MINTER_ROLE(), clearingHouse.address)

    registry = await Registry.deploy(oracle.address, clearingHouse.address, insuranceFund.address, marginAccount.address, vusd.address)

    // Setup market/amm
    weth = await ERC20Mintable.deploy('weth', 'weth', 18)
    amm = await AMM.deploy(clearingHouse.address, swap.address, weth.address, registry.address)
    await amm.togglePause(false)

    await swap.setAMM(amm.address)
    await Promise.all([
        clearingHouse.whitelistAmm(amm.address),
        marginAccount.initialize(registry.address),
        insuranceFund.initialize(registry.address),
        swap.add_liquidity([
            _1e18.mul(_1e6), // 1m USDT
            _1e6.mul(100).mul(25), // 25 btc
            _1e18.mul(1000) // 1000 eth
        ], 0)
    ])

    return { swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, weth, oracle, insuranceFund }
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

async function assertions(contracts, trader, vals, shouldLog) {
    const { amm, clearingHouse, marginAccount } = contracts
    const [ position, { notionalPosition, unrealizedPnl }, marginFraction, margin ] = await Promise.all([
        amm.positions(trader),
        amm.getNotionalPositionAndUnrealizedPnl(trader),
        clearingHouse.getMarginFraction(trader),
        marginAccount.getNormalizedMargin(trader)
    ])

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
    if (vals.margin != null) {
        expect(margin).to.eq(vals.margin)
    }
    if (vals.marginFractionNumerator != null) {
        expect(marginFraction).to.eq(vals.marginFractionNumerator.mul(_1e6).div(notionalPosition))
    }
    if (vals.marginFraction != null) {
        expect(marginFraction).to.eq(vals.marginFraction)
    }

    return { position, notionalPosition, unrealizedPnl, marginFraction }
}

async function getTwapPrice(amm, intervalInSeconds, blockTimestamp) {
    const len = await amm.getSnapshotLen()
    let snapshotIndex = len.sub(1)
    let currentSnapshot = await amm.reserveSnapshots(snapshotIndex)
    let currentPrice = currentSnapshot.quoteAssetReserve.mul(_1e6).div(currentSnapshot.baseAssetReserve)
    const baseTimestamp = blockTimestamp - intervalInSeconds
    let previousTimestamp = currentSnapshot.timestamp
    if (intervalInSeconds == 0 || len == 1 || previousTimestamp <= baseTimestamp) {
        return currentPrice
    }
    let period = BigNumber.from(blockTimestamp).sub(previousTimestamp)
    let weightedPrice = currentPrice.mul(period)
    let timeFraction = 0
    while (true) {
        if (snapshotIndex == 0) {
            return weightedPrice.div(period)
        }
        snapshotIndex = snapshotIndex.sub(1)
        currentSnapshot = await amm.reserveSnapshots(snapshotIndex)
        currentPrice = currentSnapshot.quoteAssetReserve.mul(_1e6).div(currentSnapshot.baseAssetReserve)
        if (currentSnapshot.timestamp <= baseTimestamp) {
            weightedPrice = weightedPrice.add(currentPrice.mul(previousTimestamp.sub(previousTimestamp)))
            break
        }
        timeFraction = previousTimestamp.sub(currentSnapshot.timestamp)
        weightedPrice = weightedPrice.add(currentPrice.mul(timeFraction))
        period = period.add(timeFraction)
        previousTimestamp = currentSnapshot.timestamp
    }
    return weightedPrice.div(intervalInSeconds);
}

async function impersonateAcccount(address) {
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [address],
    });
}

async function stopImpersonateAcccount(address) {
    await hre.network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [address],
    });
}

async function gotoNextFundingTime(amm) {
    // @todo check that blockTimeStamp is not already > nextFundingTime
    return network.provider.send('evm_setNextBlockTimestamp', [(await amm.nextFundingTime()).toNumber()]);
}

module.exports = {
    constants: { _1e6, _1e12, _1e18, ZERO },
    log, setupContracts, filterEvent, getTradeDetails, assertions, getTwapPrice, impersonateAcccount, stopImpersonateAcccount, gotoNextFundingTime
}
