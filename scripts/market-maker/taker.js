const ethers = require('ethers')

const { Exchange, getOpenSize, getOrdersWithinBounds } = require('./exchange');
const { bnToFloat } = require('../../test/utils');

const updateFrequency = 2e3
const dryRun = false

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY_TAKER, provider);
const exchange = new Exchange(provider)

const marketInfo = [
    { // ETH Perp
        x: 0.01, // operate +- 1% of index price
        spread: 2, // $2
        minOrderSize: 0.01,
        maxOrderSize: 0.69,
        toFixed: 2,
        baseLiquidityInMarket: 1.3 // each side
    },
    { // Avax Perp
        x: 0.02, // operate +- 1% of index price
        spread: .1, // $
        minOrderSize: 0.1,
        maxOrderSize: 69,
        toFixed: 1,
        baseLiquidityInMarket: 169 // each side
    }
]

const marketTaker = async () => {
    // try {
    //     await exchange.cancelAllOrders(signer)
    // } catch (e) {
    //     console.error('couldnt cancel order', e)
    // }
    for (let i = 0; i < marketInfo.length; i++) {
        await runForMarket(i)
    }
    // Schedule the next update
    setTimeout(marketTaker, updateFrequency);
}

async function runForMarket(market) {
    const { x, minOrderSize, maxOrderSize, baseLiquidityInMarket, toFixed } = marketInfo[market]
    try {
        let { bids, asks } = await exchange.fetchOrderBook(market);
        const underlyingPrice = (await exchange.getUnderlyingPrice())[market]

        const validBids = getOrdersWithinBounds(bids, underlyingPrice * (1-x), underlyingPrice * 2 /* high upper bound */)
        const longsOpenSize = getOpenSize(validBids)

        const validAsks = getOrdersWithinBounds(asks, 0, underlyingPrice * (1+x))
        const shortsOpenSize = getOpenSize(validAsks)

        console.log({ market, longsOpenSize, shortsOpenSize, baseLiquidityInMarket })
        if (longsOpenSize > baseLiquidityInMarket + minOrderSize) await execute(market, validBids, longsOpenSize - baseLiquidityInMarket)
        if (shortsOpenSize > baseLiquidityInMarket + minOrderSize) await execute(market, validAsks, shortsOpenSize - baseLiquidityInMarket)
    } catch (e) {
        if (e && e.error && containsErrorType(e.error.toString())) {
            try {
                await exchange.cancelAllOrders(signer)
            } catch (e) {
                console.error('couldnt cancel order', e)
            }
        } else {
            console.error(e)
        }
    }
}

async function execute(market, orders, totalSize) {
    // console.log({ market, orders, totalSize })
    if (!orders.length) return

    const { minOrderSize, maxOrderSize, toFixed } = marketInfo[market]
    let size = 0
    let price
    for (let i = 0; i < orders.length; i++) {
        // console.log({ order: orders[i] })
        size += Math.abs(orders[i].size)
        if (size >= totalSize) {
            price = orders[i].price
            break
        }
    }
    if (orders[0].size > 0) totalSize *= -1 //  taking long orders
    const { sizes } = await exchange.getMarginFractionAndPosition(signer.address)
    const nowSize = sizes[market]
    const _nowSize = bnToFloat(nowSize, 18)
    // console.log({ nowSize, _nowSize, totalSize })
    if (_nowSize && _nowSize * totalSize < 0) {
        // reduce position first
        if (Math.abs(_nowSize) <= Math.abs(totalSize)) {
            const tx = await exchange.createLimitOrderUnscaled(signer, dryRun, market, nowSize.mul(-1), ethers.utils.parseUnits(price.toFixed(6).toString(), 6), true)
            await tx.wait()
            // console.log(await exchange.createLimitOrderUnscaled(signer, dryRun, market, nowSize.mul(-1), ethers.utils.parseUnits(price.toFixed(6).toString(), 6), true))
            totalSize += _nowSize
        } else {
            return exchange.createLimitOrder(signer, dryRun, market, totalSize, price, true)
        }
    }
    totalSize = totalSize.toFixed(toFixed)
    if (Math.abs(totalSize) >= minOrderSize) {
        return exchange.createLimitOrder(signer, dryRun, market, Math.min(totalSize, maxOrderSize), price, false)
    }
}

const errorTypes = [
    'MA_reserveMargin: Insufficient margin',
    'OB_cancel_reduce_only_order_first',
    'OB_reduce_only_amount_exceeded'
];

function containsErrorType(str) {
    return errorTypes.some(errorType => str.includes(errorType));
}

// generate a random float within a min and max range
function randomFloat(min, max) {
    return Math.random() * (Math.abs(max) - Math.abs(min)) + Math.abs(min);
}

// Start the taker script
marketTaker();
