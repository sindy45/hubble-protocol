const ethers = require('ethers')
const { BigNumber } = ethers

const OBGenesisProxyAddress = '0x0300000000000000000000000000000000000069'

const domain = {
    name: 'Hubble',
    version: '2.0',
    chainId: 321123, // (await ethers.provider.getNetwork()).chainId,
    verifyingContract: OBGenesisProxyAddress // orderBook.address
}

const orderType = {
    Order: [
        // field ordering must be the same as LIMIT_ORDER_TYPEHASH
        { name: "ammIndex", type: "uint256" },
        { name: "trader", type: "address" },
        { name: "baseAssetQuantity", type: "int256" },
        { name: "price", type: "uint256" },
        { name: "salt", type: "uint256" },
        { name: "reduceOnly", type: "bool" },
    ]
}

class Exchange {
    constructor(provider) {
        this.provider = provider // new ethers.providers.JsonRpcProvider('https://internal-hubblenet-rpc.hubble.exchange/ext/bc/2ErDhAugYgUSwpeejAsCBcHY4MzLYZ5Y13nDuNRtrSWjQN5SDM/rpc')
        const orderBookAbi = require('../../artifacts/contracts/orderbooks/OrderBook.sol/OrderBook.json').abi
        this.orderBook = new ethers.Contract(OBGenesisProxyAddress, orderBookAbi, this.provider)
    }

    async fetchOrderBook(market) {
        const orderBook = (await this.provider.send('orderbook_getOrderBook', [market.toString()])).Orders
        // console.log(orderBook)
        const bids = orderBook
            .map(order => ({ price: parseFloat(order.Price) / 1e6, size: parseFloat(order.Size) / 1e18 }))
            .filter(order => order.size > 0)
            .sort((a, b) => b.price - a.price)
        const asks = orderBook
            .map(order => ({ price: parseFloat(order.Price) / 1e6, size: parseFloat(order.Size) / 1e18 }))
            .filter(order => order.size < 0)
            .sort((a, b) => a.price - b.price)
        return { bids, asks }
    }

    async getOpenOrders(trader) {
        const orderBook = (await this.provider.send('orderbook_getOpenOrders', [trader])).Orders
        return orderBook//.map(order => ({ price: parseFloat(order.Price) / 1e6, size: parseFloat(order.Size) / 1e18 }))
    }

    async fetchTicker() {
        const { bids, asks } = await this.fetchOrderBook(0)
        return { bid: bids.length ? bids[0].price : 0, ask: asks.length ? asks[0].price : 20 }
    }

    async createLimitOrder(signer, market, baseAssetQuantity, price) {
        const order = {
            ammIndex: market,
            trader: signer.address,
            baseAssetQuantity: ethers.utils.parseEther(baseAssetQuantity.toFixed(18).toString()),
            price: ethers.utils.parseUnits(price.toFixed(6).toString(), 6),
            salt: BigNumber.from(Date.now())
        }
        return this.orderBook.connect(signer).placeOrder(order)
        // return { orderHash }
        // console.log(await tx.wait())
    }

    async fetchOrder(orderHash) {
        const orderInfo = await this.orderBook.orderInfo(orderHash)
        return { status: orderInfo.status }
    }

    cancelMultipleOrders(signer, orderHashes) {
        return this.orderBook.connect(signer).cancelMultipleOrders(orderHashes)
    }
}

// const exchange = new Exchange()
// exchange.fetchTicker().then((res) => {
//     console.log(res)
// })

module.exports = Exchange


