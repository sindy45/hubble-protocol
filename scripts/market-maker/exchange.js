const ethers = require('ethers')
const { bnToFloat, sleep } = require('../../test/utils')
const { BigNumber } = ethers
const _ = require('lodash')
const crypto = require('crypto')
const OBGenesisProxyAddress = '0x0300000000000000000000000000000000000000'
const CHGenesisProxyAddress = '0x0300000000000000000000000000000000000002'

class Exchange {
    constructor(provider) {
        this.provider = provider // new ethers.providers.JsonRpcProvider('https://internal-hubblenet-rpc.hubble.exchange/ext/bc/2ErDhAugYgUSwpeejAsCBcHY4MzLYZ5Y13nDuNRtrSWjQN5SDM/rpc')

        const orderBookAbi = require('../../artifacts/contracts/orderbooks/OrderBook.sol/OrderBook.json').abi
        this.orderBook = new ethers.Contract(OBGenesisProxyAddress, orderBookAbi, this.provider)

        const clearingHouseAbi = require('../../artifacts/contracts/ClearingHouse.sol/ClearingHouse.json').abi
        this.clearingHouse = new ethers.Contract(CHGenesisProxyAddress, clearingHouseAbi, this.provider)

        const hubbleViewerABI = require('../../artifacts/contracts/HubbleViewer.sol/HubbleViewer.json').abi
        this.hubbleViewer = new ethers.Contract('0x5F1f4Eb04a82b4D78D99b6eFd412e0B69653E75b', hubbleViewerABI, this.provider)
    }

    async getCurrentPosition(trader, market) {
        const ammAddress = await this.clearingHouse.amms(market)
        const ammAbi = require('../../artifacts/contracts/AMM.sol/AMM.json').abi
        const amm = new ethers.Contract(ammAddress, ammAbi, this.provider)
        const position = await amm.positions(trader)
        return {
            size: bnToFloat(position.size, 18),
            openNotional: bnToFloat(position.openNotional),
            lastPremiumFraction: bnToFloat(position.lastPremiumFraction),
            liquidationThreshold: bnToFloat(position.liquidationThreshold, 18),
        }
    }

    async fetchOrderBook(market) {
        const orderBook = (await this.provider.send('orderbook_getOrderBook', [market.toString()])).Orders
        // console.log({ orderBook })
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

    async getOpenOrders(trader, market) {
        console.log({ trader, market })
        const orderBook = (await this.provider.send('orderbook_getOpenOrders', [trader, market.toString()])).Orders
        // console.log({ openOrders: orderBook })
        return orderBook.map(order => order.OrderId)
    }

    async getOpenOrders2(trader, market) {
        const orderBook = (await this.provider.send('orderbook_getOpenOrders', [trader, market.toString()])).Orders
        // console.log({ orderBook })
        const bids = orderBook
            .map(order => ({ price: parseFloat(order.Price) / 1e6, size: parseFloat(order.Size) / 1e18, id: order.OrderId }))
            .filter(order => order.size > 0)
            .sort((a, b) => b.price - a.price)
        const asks = orderBook
            .map(order => ({ price: parseFloat(order.Price) / 1e6, size: parseFloat(order.Size) / 1e18, id: order.OrderId }))
            .filter(order => order.size < 0)
            .sort((a, b) => a.price - b.price)
        return { bids, asks }
    }

    async getReduceOnlyOrders(trader) {
        const orderBook = (await this.provider.send('orderbook_getOpenOrders', [trader])).Orders
        // console.log({ openOrders: orderBook })
        return _.filter(orderBook, order => order.ReduceOnly == true)
    }

    async fetchTicker() {
        const { bids, asks } = await this.fetchOrderBook(0)
        // console.log({ bids, asks })
        return { bid: bids.length ? bids[0].price : undefined, ask: asks.length ? asks[0].price : undefined }
    }

    async createLimitOrder(signer, dryRun, market, baseAssetQuantity, price, reduceOnly=false, txOpts={}) {
        console.log(`Executed ${baseAssetQuantity > 0 ? 'long' : 'short'} ${baseAssetQuantity} at $${price}`)
        return this.createLimitOrderUnscaled(signer, dryRun, market, ethers.utils.parseEther(baseAssetQuantity.toString()), ethers.utils.parseUnits(price.toFixed(6).toString(), 6), reduceOnly, txOpts)
    }

    async placeOrders(signer, dryRun, orders, txOpts={}) {
        if (!dryRun) return this.orderBook.connect(signer).placeOrders(orders, txOpts)
    }

    buildOrderObj(trader, ammIndex, baseAssetQuantity, price, reduceOnly=false) {
        return {
            ammIndex,
            trader,
            baseAssetQuantity: ethers.utils.parseEther(baseAssetQuantity.toString()),
            price: ethers.utils.parseUnits(price.toFixed(6).toString(), 6),
            salt: BigNumber.from('0x' + crypto.randomBytes(16).toString('hex')),
            reduceOnly
        }
    }

    async createLimitOrderUnscaled(signer, dryRun, market, baseAssetQuantity, price, reduceOnly=false, txOpts={}) {
        // console.log({ dryRun, baseAssetQuantity, price, reduceOnly })
        if (dryRun || !baseAssetQuantity) return
        const order = {
            ammIndex: market,
            trader: signer.address,
            baseAssetQuantity,
            price,
            salt: BigNumber.from(Date.now()),
            reduceOnly
        }
        // console.log({ order })
        // const orderHash = await this.orderBook.getOrderHash(order)
        // const estimateGas = await this.orderBook.connect(signer).estimateGas.placeOrders([order], signature)
        // console.log({ estimateGas })
        return this.orderBook.connect(signer).placeOrders([order], txOpts)
        // return tx.wait()
    }

    async getMarginFraction(trader) {
        // trader = ethers.utils.getAddress(trader)
        const marginFraction = await this.clearingHouse.calcMarginFraction(trader, false, 0)
        return bnToFloat(marginFraction)
    }

    async fetchOrder(orderHash) {
        const orderInfo = await this.orderBook.orderInfo(orderHash)
        return { status: orderInfo.status }
    }

    async cancelOrders(signer, orders) {
        return this.orderBook.connect(signer).cancelOrders(orders)
    }

    // to fix
    // async cancelAllOrders(signer) {
    //     return this.cancelOrders(signer, await this.getOpenOrders(signer.address, ''))
    // }

    async getMarginFractionAndPosition(trader) {
        const [ { freeMargin, marginFraction }, sizes ] = await Promise.all([
            this.hubbleViewer.getAccountInfo(trader),
            this.hubbleViewer.userPositions(trader)
        ])
        // console.log({ freeMargin, marginFraction, size })
        return {
            marginFraction: bnToFloat(marginFraction),
            sizes: sizes.map(s => s.size),
            freeMargin: bnToFloat(freeMargin)
        }
    }

    async getUnderlyingPrice() {
        const prices = await this.clearingHouse.getUnderlyingPrice()
        return prices.map(price => bnToFloat(price))
    }
}

const getOpenSize = (orders) => {
    return orders.reduce((accumulator, currentValue) => {
        return accumulator + Math.abs(currentValue.size)
    }, 0)
}

const getOrdersWithinBounds = (orders, lower, upper) => {
    return orders.filter(order => order.price >= lower && order.price <= upper)
}

module.exports = { Exchange, getOpenSize, getOrdersWithinBounds }
