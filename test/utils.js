const { expect } = require('chai')
const fs = require('fs')
const { BigNumber } = require('ethers')

const _1e6 = BigNumber.from(10).pow(6)
const _1e12 = BigNumber.from(10).pow(12)
const _1e18 = ethers.constants.WeiPerEther
const ZERO = BigNumber.from(0)

const DEFAULT_TRADE_FEE = 0.0005 * 1e6 /* 0.05% */

function log(position, notionalPosition, unrealizedPnl, marginFraction, size, openNotional) {
    console.log({
        size: position.size.toString(),
        openNotional: position.openNotional.toString(),
        notionalPosition: notionalPosition.toString(),
        unrealizedPnl: unrealizedPnl.toString(),
        marginFraction: marginFraction.toString(),
        totalSize: size.toString(),
        totalOpenNotional: openNotional.toString()
    })
}

async function setupContracts(tradeFee = DEFAULT_TRADE_FEE, options = { addLiquidity: true }) {
    governance = alice

    // Vyper
    let abiAndBytecode = fs.readFileSync('./vyper/MoonMath.txt').toString().split('\n').filter(Boolean)
    const MoonMath = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./vyper/Views.txt').toString().split('\n').filter(Boolean)
    const Views = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    vammAbiAndBytecode = fs.readFileSync('./vyper/Swap.txt').toString().split('\n').filter(Boolean)
    Swap = new ethers.ContractFactory(JSON.parse(vammAbiAndBytecode[0]), vammAbiAndBytecode[1], signers[0])

    moonMath = await MoonMath.deploy()
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

    ;([ proxyAdmin, usdc, weth ] = await Promise.all([
        ProxyAdmin.deploy(),
        ERC20Mintable.deploy('USD Coin', 'USDC', 6),
        ERC20Mintable.deploy('WETH', 'WETH', 18)
    ]))

    const vusd = await setupUpgradeableProxy('VUSD', proxyAdmin.address, [ governance ], [ usdc.address ])

    oracle = await setupUpgradeableProxy('TestOracle', proxyAdmin.address, [ governance ])
    await oracle.setStablePrice(vusd.address, 1e6) // $1

    forwarder = await MinimalForwarder.deploy()
    await forwarder.intialize()

    marginAccount = await setupUpgradeableProxy('MarginAccount', proxyAdmin.address, [ forwarder.address, governance, vusd.address ])
    marginAccountHelper = await MarginAccountHelper.deploy(marginAccount.address, vusd.address)
    insuranceFund = await setupUpgradeableProxy('InsuranceFund', proxyAdmin.address, [ governance ])

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
    await vusd.grantRole(await vusd.MINTER_ROLE(), clearingHouse.address)

    registry = await Registry.deploy(oracle.address, clearingHouse.address, insuranceFund.address, marginAccount.address, vusd.address)
    await Promise.all([
        marginAccount.syncDeps(registry.address, 5e4), // liquidationIncentive = 5% = .05 scaled 6 decimals
        insuranceFund.syncDeps(registry.address)
    ])

    vammImpl = await Swap.deploy()
    ;({ amm, vamm } = await setupAmm(
        governance,
        [ registry.address, weth.address, 'ETH-Perp' ],
        1000, // initialRate,
        options.addLiquidity ? 1000 : 0 // initialLiquidity
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
    const factory = await ethers.getContractFactory(contract)
    let impl
    if (deployArgs) {
        impl = await factory.deploy(...deployArgs)
    } else {
        impl = await factory.deploy()
    }
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
    return ethers.getContractAt(contract, proxy.address)
}

async function setupAmm(governance, args, initialRate, initialLiquidity, _pause = false, index = 0) {
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

    const vamm = new ethers.Contract(VammProxy.address, JSON.parse(vammAbiAndBytecode[0]), signers[0])
    const amm = await setupUpgradeableProxy('AMM', proxyAdmin.address, args.concat([ vamm.address, governance ]))
    if (!_pause) {
        await amm.togglePause(_pause)
    }
    await vamm.setAMM(amm.address)

    await clearingHouse.whitelistAmm(amm.address)

    if (initialLiquidity) {
        maker = (await ethers.getSigners())[9]
        await addMargin(maker, _1e6.mul(initialLiquidity * initialRate * 2))
        await clearingHouse.connect(maker).addLiquidity(index, _1e18.mul(initialLiquidity), 0)
    }
    return { amm, vamm }
}

async function addMargin(trader, margin) {
    await usdc.mint(trader.address, margin)
    await usdc.connect(trader).approve(marginAccountHelper.address, margin)
    await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
}

async function filterEvent(tx, name) {
    const { events } = await tx.wait()
    return events.find(e => e.event == name)
}

async function getTradeDetails(tx, tradeFee = DEFAULT_TRADE_FEE) {
    const positionModifiedEvent = await filterEvent(tx, 'PositionModified')
    return {
        quoteAsset: positionModifiedEvent.args.quoteAsset,
        fee: positionModifiedEvent.args.quoteAsset.mul(tradeFee).div(_1e6)
    }
}

async function parseRawEvent(tx, emitter, name) {
    const { events } = await tx.wait()
    const event = events.find(e => {
        if (e.address == emitter.address) {
            return emitter.interface.parseLog(e).name == name
        }
        return false
    })
    return emitter.interface.parseLog(event)
}

async function assertions(contracts, trader, vals, shouldLog) {
    const { amm, clearingHouse, marginAccount } = contracts
    const [ position, { notionalPosition, unrealizedPnl, size, openNotional }, marginFraction, margin ] = await Promise.all([
        amm.positions(trader),
        amm.getNotionalPositionAndUnrealizedPnl(trader),
        clearingHouse.getMarginFraction(trader),
        marginAccount.getNormalizedMargin(trader)
    ])

    if (shouldLog) {
        log(position, notionalPosition, unrealizedPnl, marginFraction, size, openNotional)
    }

    if (vals.size != null) {
        expect(size).to.eq(vals.size)
    }
    if (vals.openNotional != null) {
        expect(openNotional).to.eq(vals.openNotional)
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
            weightedPrice = weightedPrice.add(currentPrice.mul(previousTimestamp.sub(baseTimestamp)))
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

function forkNetwork(_network, blockNumber) {
    return network.provider.request({
        method: "hardhat_reset",
        params: [{
            forking: {
                jsonRpcUrl: `https://eth-${_network}.alchemyapi.io/v2/${process.env.ALCHEMY}`,
                blockNumber
            }
        }]
    })
}

async function signTransaction(signer, to, data, forwarder, value = 0, gas = 1000000) {
    const types = {
        ForwardRequest: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'gas', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'data', type: 'bytes' },
        ],
    }

    const domain = {
        name: 'MinimalForwarder',
        version: '0.0.1',
        chainId: await web3.eth.getChainId(),
        verifyingContract: forwarder.address,
    }

    const req = {
        from: signer.address,
        to: to.address,
        value,
        gas,
        nonce: (await forwarder.getNonce(signer.address)).toString(),
        data
    };
    const sign = await signer._signTypedData(domain, types, req)
    return { sign, req }
}

async function assertBounds(v, lowerBound, upperBound) {
    if (lowerBound) expect(v).gt(lowerBound)
    if (upperBound) expect(v).lt(upperBound)
}

module.exports = {
    constants: { _1e6, _1e12, _1e18, ZERO },
    log,
    setupContracts,
    setupUpgradeableProxy,
    filterEvent,
    getTradeDetails,
    assertions,
    getTwapPrice,
    impersonateAcccount,
    stopImpersonateAcccount,
    gotoNextFundingTime,
    forkNetwork,
    setupAmm,
    signTransaction,
    addMargin,
    parseRawEvent,
    assertBounds,
    BigNumber
}
