const ethers = require('ethers')

const Exchange = require('./exchange')

const market = 0;
const spread = 10;
const maxOrderSize = 1.2;
const updateFrequency = 2e3;
const numOrders = 1;

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY_MAKER, provider);
const exchange = new Exchange(provider)
const dryRun = false

const submitOrders = async (bid, ask) => {
    console.log(`Bid: ${bid}, Ask: ${ask}`)
    const midPrice = (bid + ask) / 2;

    for (let i = 0; i < numOrders; i++) {
        const randomBuyPrice = randomFloat(bid, midPrice + spread)
        const randomSellPrice = randomFloat(midPrice + spread, ask)

        let _orderSize = randomSize(maxOrderSize)
        console.log(`Placing a long for ${_orderSize} ETH at $${randomBuyPrice}`)
        if (!dryRun) await exchange.createLimitOrder(signer, market, randomSize(maxOrderSize), randomBuyPrice);

        _orderSize = randomSize(maxOrderSize)
        console.log(`Placing a short for ${_orderSize} ETH at $${randomSellPrice}`)
        if (!dryRun) await exchange.createLimitOrder(signer, market, randomSize(maxOrderSize) * -1, randomSellPrice);
    }
};

const marketMaker = async () => {
    // determine the hardhat network the script is running on
    // const network = await ethers.provider.getNetwork();
    // console.log(`Running on network: ${network.name}`);

    try {
        // const ticker = await exchange.fetchTicker(market);
        ticker = { bid: 1900, ask: 2100 }
        await submitOrders(ticker.bid, ticker.ask);
        console.log(`Submitted ${numOrders} buy and sell orders`);
    } catch (error) {
        console.error('Error in marketMaker function:', error);
    }

    // Schedule the next update
    setTimeout(marketMaker, updateFrequency);
};

// cancels all orders placed by the market maker
const cancelAllOrders = async () => {
    // determine the hardhat network the script is running on
    // const network = await ethers.provider.getNetwork();
    // console.log(`Running on network: ${network.name}`);
    let orders = await exchange.getOpenOrders(signer.address);
    console.log(orders.length)
    while (orders.length) {
        const _orders = orders.slice(0, 15).map(o => {
            return {
                ammIndex: o.Market,
                trader: signer.address,
                baseAssetQuantity: o.Size,
                price: o.Price,
                salt: o.Salt,
            }
        })
        await exchange.cancelMultipleOrders(signer, _orders)
        orders = orders.slice(15)
    }
};

// generate a random float within a given range
function randomSize(q) {
    const size = Math.random() * Math.abs(q)
    return size > maxOrderSize ? maxOrderSize : size
}

// generate a random float within a min and max range
function randomFloat(min, max) {
    return Math.random() * (Math.abs(max) - Math.abs(min)) + Math.abs(min);
}

// Start the market-making algorithm
marketMaker();
// cancelAllOrders();