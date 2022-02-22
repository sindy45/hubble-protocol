const { expect } = require('chai')
const fs = require('fs')
const { BigNumber } = require('ethers')
const util = require('util')
const { ethers, network } = require('hardhat')

const ZERO = BigNumber.from(0)
const _1e6 = BigNumber.from(10).pow(6)
const _1e8 = BigNumber.from(10).pow(8)
const _1e12 = BigNumber.from(10).pow(12)
const _1e18 = ethers.constants.WeiPerEther

const DEFAULT_TRADE_FEE = 0.0005 * 1e6 /* 0.05% */
const gasLimit = 6e6

let txOptions = {}

/**
 * signers global var should have been intialized before the call to this fn
 * @dev { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit } is a weird quirk that lets us use this script for both local testing and prod deployments
*/
async function setupContracts(options = {}) {
    options = Object.assign(
        {
            tradeFee: DEFAULT_TRADE_FEE,
            restrictedVUSD: true,
            governance: signers[0].address,
            setupAMM: true,
            testOracle: true,
            mockMarginAccount: false
        },
        options
    )
    ;({ governance } = options)

    ;([
        MarginAccountHelper,
        Registry,
        ERC20Mintable,
        AMM,
        MinimalForwarder,
        TransparentUpgradeableProxy,
        ProxyAdmin
    ] = await Promise.all([
        ethers.getContractFactory('MarginAccountHelper'),
        ethers.getContractFactory('Registry'),
        ethers.getContractFactory('ERC20Mintable'),
        ethers.getContractFactory('AMM'),
        ethers.getContractFactory('contracts/MinimalForwarder.sol:MinimalForwarder'),
        ethers.getContractFactory('TransparentUpgradeableProxy'),
        ethers.getContractFactory('ProxyAdmin')
    ]))

    ;([ proxyAdmin, forwarder, usdc ] = await Promise.all([
        ProxyAdmin.deploy({ nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }),
        MinimalForwarder.deploy({ nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }),
        ERC20Mintable.deploy('USD Coin', 'USDC', 6, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }),
    ]))
    vusd = await setupUpgradeableProxy(options.restrictedVUSD ? 'RestrictedVusd' : 'VUSD', proxyAdmin.address, [ governance ], [ usdc.address ])

    marginAccount = await setupUpgradeableProxy(
        `${options.mockMarginAccount ? 'Mock' : ''}MarginAccount`,
        proxyAdmin.address,
        [ governance, vusd.address ],
        [ forwarder.address ]
    )
    marginAccountHelper = await MarginAccountHelper.deploy(marginAccount.address, vusd.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
    insuranceFund = await setupUpgradeableProxy('InsuranceFund', proxyAdmin.address, [ governance ])

    if (options.restrictedVUSD) {
        const transferRole = await vusd.TRANSFER_ROLE()
        await Promise.all([
            vusd.grantRole(transferRole, marginAccountHelper.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }),
            vusd.grantRole(transferRole, marginAccount.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }),
            vusd.grantRole(transferRole, insuranceFund.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
        ])
    }

    oracle = await setupUpgradeableProxy(options.testOracle ? 'TestOracle' : 'Oracle', proxyAdmin.address, [ governance ])
    await oracle.setStablePrice(vusd.address, 1e6, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }) // $1

    clearingHouse = await setupUpgradeableProxy(
        'ClearingHouse',
        proxyAdmin.address,
        [
            governance,
            insuranceFund.address,
            marginAccount.address,
            vusd.address,
            0.1 * 1e6, // 10% maintenance margin, 10x
            0.2 * 1e6, // 20% minimum allowable margin, 5x
            options.tradeFee,
            0.05 * 1e6, // liquidationPenalty = 5%
        ],
        [ forwarder.address ]
    )
    await vusd.grantRole(await vusd.MINTER_ROLE(), marginAccount.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
    registry = await Registry.deploy(oracle.address, clearingHouse.address, insuranceFund.address, marginAccount.address, vusd.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
    await Promise.all([
        marginAccount.syncDeps(registry.address, 5e4, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }), // liquidationIncentive = 5% = .05 scaled 6 decimals
        insuranceFund.syncDeps(registry.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
    ])
    const HubbleViewer = await ethers.getContractFactory('HubbleViewer')
    hubbleViewer = await HubbleViewer.deploy(clearingHouse.address, marginAccount.address, registry.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })

    const Leaderboard = await ethers.getContractFactory('Leaderboard')
    leaderboard = await Leaderboard.deploy(hubbleViewer.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })

    // we will initialize the amm deps so that can be used as  global vars later
    let abiAndBytecode = fs.readFileSync('./contracts/curve-v2/CurveMath.txt').toString().split('\n').filter(Boolean)
    const CurveMath = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    abiAndBytecode = fs.readFileSync('./contracts/curve-v2/Views.txt').toString().split('\n').filter(Boolean)
    const Views = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

    vammAbiAndBytecode = fs.readFileSync('./contracts/curve-v2/Swap.txt').toString().split('\n').filter(Boolean)
    Swap = new ethers.ContractFactory(JSON.parse(vammAbiAndBytecode[0]), vammAbiAndBytecode[1], signers[0])
    ;([ curveMath, vammImpl, ammImpl ] = await Promise.all([
        CurveMath.deploy({ nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }),
        Swap.deploy({ nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }),
        AMM.deploy({ nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
    ]))
    views = await Views.deploy(curveMath.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
    // amm deps complete

    const res = {
        registry,
        marginAccount,
        marginAccountHelper,
        clearingHouse,
        hubbleViewer,
        vusd,
        usdc,
        oracle,
        insuranceFund,
        forwarder,
        vammImpl,
        tradeFee: options.tradeFee,
    }

    if (options.setupAMM) {
        weth = await setupRestrictedTestToken('Hubble Ether', 'hWETH', 18)
        ;({ amm, vamm } = await setupAmm(
            governance,
            [ registry.address, weth.address, 'ETH-PERP' ],
            options.amm
        ))
        Object.assign(res, { swap: vamm, amm, weth })
    }

    // console.log(await generateConfig(leaderboard.address))
    return res
}

async function setupUpgradeableProxy(contract, admin, initArgs, deployArgs = []) {
    const factory = await ethers.getContractFactory(contract)
    const impl = await factory.deploy(...deployArgs, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
    const proxy = await TransparentUpgradeableProxy.deploy(
        impl.address,
        admin,
        initArgs
            ? impl.interface.encodeFunctionData(
                contract === 'VUSD' || contract === 'RestrictedVusd' ? 'init' : 'initialize',
                initArgs
            )
            : '0x',
        { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }
    )
    return ethers.getContractAt(contract, proxy.address)
}

async function setupAmm(governance, args, ammOptions) {
    const { initialRate, initialLiquidity, fee, ammState, index } = Object.assign(
        {
            index: 0,
            initialRate: 1000, // for ETH perp
            initialLiquidity: 1000, // 1000 eth
            fee: 10000000, // 0.1%
            ammState: 2, // Active
        },
        ammOptions
    )
    const vammProxy = await TransparentUpgradeableProxy.deploy(
        vammImpl.address,
        proxyAdmin.address,
        vammImpl.interface.encodeFunctionData('initialize', [
            governance, // owner
            curveMath.address, // math
            views.address, // views
            400000, // A
            '145000000000000', // gamma
            fee, 0, 0, 0, // mid_fee, out_fee, allowed_extra_profit, fee_gamma
            '146000000000000', // adjustment_step
            0, // admin_fee
            600, // ma_half_time
            // _1e18.mul(initialRate)
        ]),
        { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }
    )

    const vamm = new ethers.Contract(vammProxy.address, JSON.parse(vammAbiAndBytecode[0]), signers[0])
    const ammProxy = await TransparentUpgradeableProxy.deploy(
        ammImpl.address,
        proxyAdmin.address,
        ammImpl.interface.encodeFunctionData('initialize', args.concat([ vamm.address, governance ])),
        { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit }
    )
    const amm = await ethers.getContractAt('AMM', ammProxy.address)
    await vamm.setAMM(amm.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })

    if (initialRate) {
        // amm.liftOff() needs the price for the underlying to be set
        await oracle.setUnderlyingTwapPrice(await amm.underlyingAsset(), _1e6.mul(initialRate))
    }

    if (ammState > 0) { // Ignition or Active
        await clearingHouse.whitelistAmm(amm.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
        if (initialLiquidity) {
            await commitLiquidity(index, initialLiquidity, initialRate)
        }
        if (ammState == 2) { // Active
            await amm.liftOff()
        }
    }

    return { amm, vamm }
}

async function commitLiquidity(index, initialLiquidity, rate) {
    maker = (await ethers.getSigners())[9]
    const netUSD = _1e6.mul(initialLiquidity * rate * 2)
    await addMargin(maker, netUSD)
    await clearingHouse.connect(maker).commitLiquidity(index, netUSD)
}

async function addLiquidity(index, liquidity, rate, minDtoken = 0) {
    maker = (await ethers.getSigners())[9]
    const netUSD = _1e6.mul(liquidity * rate * 2)
    await addMargin(maker, netUSD)
    await clearingHouse.connect(maker).addLiquidity(index, _1e18.mul(liquidity), minDtoken)
}

async function setupRestrictedTestToken(name, symbol, decimals) {
    const RestrictedErc20 = await ethers.getContractFactory('RestrictedErc20')
    const tok = await RestrictedErc20.deploy(name, symbol, decimals, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
    // avoiding await tok.TRANSFER_ROLE(), because that reverts if the above tx hasn't confirmed
    await tok.grantRole(ethers.utils.id('TRANSFER_ROLE'), marginAccount.address, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
    return tok
}

async function addMargin(trader, margin) {
    // omitting the nonce calculation here because this is only used in local
    await usdc.mint(trader.address, margin, { nonce: txOptions.nonce ? txOptions.nonce++ : undefined, gasLimit })
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
    let currentPrice = currentSnapshot.lastPrice
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
        currentPrice = currentSnapshot.lastPrice
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

async function generateConfig(leaderboardAddress) {
    const leaderboard = await ethers.getContractAt('Leaderboard', leaderboardAddress)
    const hubbleViewer = await ethers.getContractAt('HubbleViewer', await leaderboard.hubbleViewer())
    const clearingHouse = await ethers.getContractAt('ClearingHouse', await hubbleViewer.clearingHouse())
    const marginAccount = await ethers.getContractAt('MarginAccount', await hubbleViewer.marginAccount())

    const _amms = await clearingHouse.getAMMs()
    const amms = []
    for (let i = 0; i < _amms.length; i++) {
        const a = await ethers.getContractAt('AMM', _amms[i])
        amms.push({
            perp: await a.name(),
            address: a.address,
            underlying: await a.underlyingAsset()
        })
    }
    let _collateral = await marginAccount.supportedAssets()
    const collateral = []
    for (let i = 0; i < _collateral.length; i++) {
        const asset = await ethers.getContractAt('ERC20PresetMinterPauser', _collateral[i].token)
        collateral.push({
            name: await asset.name(),
            ticker: await asset.symbol(),
            decimals: await asset.decimals(),
            address: asset.address
        })
    }

    // to find the genesis block, we will get the block in which the first amm was whitelisted
    const marketAddedEvents = await clearingHouse.queryFilter('MarketAdded')
    const genesisBlock = marketAddedEvents[0].blockNumber
    return {
        genesisBlock,
        timestamp: (await ethers.provider.getBlock(genesisBlock)).timestamp,
        contracts: {
            ClearingHouse: clearingHouse.address,
            HubbleViewer: hubbleViewer.address,
            MarginAccount: marginAccount.address,
            Oracle: await marginAccount.oracle(),
            InsuranceFund: await marginAccount.insuranceFund(),
            Registry: await hubbleViewer.registry(),
            amms,
            collateral,
        },
        systemParams: {
            maintenanceMargin: (await clearingHouse.maintenanceMargin()).toString(),
            numCollateral: collateral.length
        }
    }
}

function sleep(s) {
    return new Promise(resolve => setTimeout(resolve, s * 1000));
}

function bnToFloat(num, decimals = 6) {
    return parseFloat(ethers.utils.formatUnits(num.toString(), decimals))
}

async function unbondAndRemoveLiquidity(signer, amm, index, dToken, minQuote, minBase) {
    await amm.connect(signer).unbondLiquidity(dToken)
    await gotoNextUnbondEpoch(amm, signer.address)
    return clearingHouse.connect(signer).removeLiquidity(index, dToken, minQuote, minBase)
}

async function gotoNextWithdrawEpoch(amm, maker) {
    return network.provider.send(
        'evm_setNextBlockTimestamp',
        [(await amm.makers(maker)).unbondTime.toNumber() + 86401]
    );
}

async function gotoNextUnbondEpoch(amm, maker) {
    return network.provider.send(
        'evm_setNextBlockTimestamp',
        [(await amm.makers(maker)).unbondTime.toNumber()]
    );
}

module.exports = {
    constants: { _1e6, _1e8, _1e12, _1e18, ZERO },
    BigNumber,
    txOptions,
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
    setupRestrictedTestToken,
    signTransaction,
    addMargin,
    parseRawEvent,
    assertBounds,
    generateConfig,
    sleep,
    commitLiquidity,
    addLiquidity,
    bnToFloat,
    unbondAndRemoveLiquidity,
    gotoNextWithdrawEpoch,
    gotoNextUnbondEpoch
}
