const ethers = require('ethers')

const Exchange = require('./exchange')

// const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
const provider = new ethers.providers.JsonRpcProvider('http://54.88.145.1:9650/ext/bc/2ErDhAugYgUSwpeejAsCBcHY4MzLYZ5Y13nDuNRtrSWjQN5SDM/rpc')
const signer = new ethers.Wallet(process.env.PRIVATE_KEY_TAKER, provider);
const exchange = new Exchange(provider)
const dryRun = false

const market = 0;
const updateFrequency = 1e3;
const maxOrderSize = 19

const marketTaker = async () => {
    try {
        let { bids, asks } = await exchange.fetchOrderBook(market);
        // filter all asks that are > 20 in price
        asks = asks.filter(ask => ask.price < 20)

        if (asks.length) {
            const askIndex = Math.floor(Math.random() * asks.length/2);
            const selectedAsk = asks[askIndex];
            // console.log({ askIndex, selectedAsk })

            // we will fill all orders until askIndex
            let q = 0
            for (let i = 0; i < askIndex; i++) {
                // console.log(`Filling ${asks[i].size} ETH at $${asks[i].price}`)
                q += asks[i].size
            }
            console.log({ totalBids: asks.length, askIndex, selectedAsk, q: q + selectedAsk.size })
            // for the last order at askIndex, we will only partially fill it
            const _orderSize = randomFloat(q, q + selectedAsk.size)
            if (!dryRun) await exchange.createLimitOrder(signer, 0, _orderSize, selectedAsk.price)
            console.log(`Executed long for ${_orderSize} ETH at $${selectedAsk.price}`)
        }

        if (bids.length) {
            const bidIndex = Math.floor(Math.random() * bids.length/2);

            const selectedBid = bids[bidIndex];

            // we will fill all orders until askIndex
            let q = 0
            for (let i = 0; i < bidIndex; i++) {
                // console.log(`Filling ${bids[i].size} ETH at $${bids[i].price}`)
                q += bids[i].size
            }
            console.log({ totalBids: bids.length, bidIndex, selectedBid, q: q + selectedBid.size })
            // for the last order at askIndex, we will only partially fill it
            const _orderSize = randomFloat(q, q + selectedBid.size) * -1
            if (!dryRun) await exchange.createLimitOrder(signer, 0, _orderSize, selectedBid.price)
            console.log(`Executed short for ${_orderSize} ETH at $${selectedBid.price}`)
        }
    } catch (error) {
        console.error('Error in marketTaker function:', error);
    }

    // Schedule the next update
    setTimeout(marketTaker, updateFrequency);
};

async function showNonce() {
    console.log(await signer.getTransactionCount())
}

// cancels all orders placed by the market maker
const cancelAllOrders = async () => {
    let orders = await exchange.getOpenOrders(signer.address);
    console.log(orders.length)
    while (orders.length) {
        const _orders = orders.slice(0, 11).map(o => {
            return {
                ammIndex: o.Market,
                trader: signer.address,
                baseAssetQuantity: o.Size,
                price: o.Price,
                salt: o.Salt,
            }
        })
        await exchange.cancelMultipleOrders(signer, _orders)
        orders = orders.slice(11)
    }
};

// generate a random float within a given range
function randomSize(q) {
    const size = Math.random() * Math.abs(q)
    return size > maxOrderSize ? maxOrderSize : size
}

// generate a random float within a min and max range
function randomFloat(min, max) {
    const size = Math.random() * (Math.abs(max) - Math.abs(min)) + Math.abs(min);
    return size > maxOrderSize ? maxOrderSize : size
}

// Start the taker script
// marketTaker();
// showNonce();
cancelAllOrders()
