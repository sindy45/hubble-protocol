const ethers = require('ethers')

const { Exchange, getOpenSize, getOrdersWithinBounds } = require('./exchange');
const { bnToFloat } = require('../../test/utils');

const updateFrequency = 2e3;
const dryRun = false
const maxLeverage = 1.9
const numOrders = 15;

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY_MAKER, provider);
const exchange = new Exchange(provider)

const marketInfo = [
    { // ETH Perp
        x: 0.01, // operate +- 1% of index price
        spread: 2, // $2
        minOrderSize: 0.01,
        maxOrderSize: .42,
        toFixed: 2,
        baseLiquidityInMarket: 4.2 // each side
    },
    { // Avax Perp
        x: 0.02, // operate +- 1% of index price
        spread: .1, // $
        minOrderSize: 0.1,
        toFixed: 1,
        baseLiquidityInMarket: 560 // each side
    }
]

const marketMaker = async () => {
    for (let i = 0; i < marketInfo.length; i++) {
        await runForMarket(i)
    }

    // Schedule the next update
    setTimeout(marketMaker, updateFrequency);
};

async function runForMarket(market) {
    const { x, spread } = marketInfo[market]
    try {
        let { bids, asks } = await exchange.getOpenOrders2(signer.address, market)
        const underlyingPrice = (await exchange.getUnderlyingPrice())[market]
        // console.log({ bids, asks, underlyingPrice })

        // we will always cater in +-x% of underlying price and close rest of the orders
        const validBids = getOrdersWithinBounds(bids, underlyingPrice * (1-x), underlyingPrice - spread/2)
        const validAsks = getOrdersWithinBounds(asks, underlyingPrice + spread/2, underlyingPrice * (1+x))

        // cancel long orders that are </> than +-x% of underlying price
        let idsToClose = bids.filter(bid => !validBids.includes(bid)).map(bid => bid.id).concat(
            asks.filter(ask => !validAsks.includes(ask)).map(ask => ask.id)
        )
        if (!dryRun && idsToClose.length) await exchange.cancelMultipleOrders(signer, idsToClose)
        await decideStrategy(bids, asks, underlyingPrice, market)
    } catch (error) {
        console.error('Error in marketMaker function:', error);
    }
}

const decideStrategy = async (bids, asks, underlyingPrice, market) => {
    let { x, spread, minOrderSize, baseLiquidityInMarket } = marketInfo[market]
    let { marginFraction, sizes } = await exchange.getMarginFractionAndPosition(signer.address)
    const size = bnToFloat(sizes[market], 18)
    const leverage = marginFraction != 0 ? 1 / marginFraction : 0

    const shortLB = underlyingPrice + spread/2
    const shortUB = underlyingPrice * (1+x)
    // sum size for all orders
    const shortOpenSize = getOpenSize(asks)

    const longLB = underlyingPrice * (1-x)
    const longUB = underlyingPrice - spread/2
    const longOpenSize = getOpenSize(bids)
    console.log({ leverage, size, shortOpenSize, longOpenSize, shortUB, shortLB, underlyingPrice, longUB, longLB })

    let shouldLong = true
    let shouldShort = true
    let reduceOnly = false

    // If leverage is greater than the threshold, place orders to reduce open position and cancel opposite orders
    if (Math.abs(leverage) > maxLeverage) {
        console.log(`Leverage=${leverage} is above threshold`)
        baseLiquidityInMarket = Math.abs(size) // reduce leverage to 3/4 of current
        reduceOnly = true // so that these orders don't use margin
        if (size > 0) { // place only short orders
            shouldLong = false
        } else if (size < 0) { // place only long orders
            shouldShort = false
        }
    }

    shouldShort = shouldShort && shortOpenSize + minOrderSize < baseLiquidityInMarket
    shouldLong = shouldLong && longOpenSize + minOrderSize < baseLiquidityInMarket
    // console.log({ baseLiquidityInMarket, shouldLong, shouldShort })
    if (shouldShort) {
        await submitOrders(shortLB, asks.length ? asks[0].price : shortUB, "SHORT", baseLiquidityInMarket - shortOpenSize, reduceOnly, market, minOrderSize)
    }
    if (shouldLong) {
        await submitOrders(bids.length ? bids[0].price : longLB, longUB, "LONG", baseLiquidityInMarket - longOpenSize, reduceOnly, market, minOrderSize)
    }
}

const submitOrders = async (lower, upper, type, totalSize, reduceOnly, market) => {
    const { minOrderSize, maxOrderSize, toFixed } = marketInfo[market]
    // for this run maxOrderSize will be a random number b/w .8 to 1 of maxOrderSize
    let _maxOrderSize = parseFloat((randomFloat(.8, 1) * maxOrderSize).toFixed(toFixed))
    // e.g. we will place 5 orders at 20% intervals
    const interval = (upper - lower) / numOrders
    // console.log({ upper, lower, interval })
    let sizes = generateRandomArray(numOrders, totalSize, minOrderSize, _maxOrderSize, toFixed)
    // console.log({ sizes })
    if (type == "SHORT") sizes = sizes.map(size => -size)
    const tasks = []
    for (let i = 0; i < sizes.length; i++) {
        await exchange.createLimitOrder(signer, dryRun, market, sizes[i], type == "LONG" ? upper - i * interval : upper - (i+1) * interval, reduceOnly)
    }
    return Promise.all(tasks)
}

// generate a random float within a min and max range
function randomFloat(min, max) {
    return Math.random() * (Math.abs(max) - Math.abs(min)) + Math.abs(min);
}

// write a function to generate an array of `numOrders` length such that the elements are randomly generated and sum to `totalSize`
// also each element should within +- 10% of the element before and after it. and no element is 0.
function generateRandomArray(numOrders, totalSize, minOrderSize, maxOrderSize, toFixed) {
    const result = [];
    let sum = 0;
    // console.log({ totalSize })
    for (let i = 0; i < numOrders - 1; i++) {
        const remaining = parseFloat((totalSize - sum).toFixed(toFixed))
        if (remaining < minOrderSize) break;
        let current = Math.min(parseFloat(randomFloat(minOrderSize, remaining).toFixed(toFixed)), maxOrderSize)
        // console.log({ current, totalSize, sum, remaining })
        if (current >= minOrderSize) {
            result.push(current);
            sum += current;
        }
    }

    // Add the last element so that the sum equals totalSize
    const remaining = Math.min(parseFloat((totalSize - sum).toFixed(toFixed)), maxOrderSize)
    if (remaining >= minOrderSize) result.push(totalSize - sum)
    return result;
}

// Start the market-making algorithm
marketMaker();
