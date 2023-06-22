const ethers = require('ethers')
const { BigNumber } = require('ethers')
const { parseLog } = require('ethereum-event-logs')

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL_ARCHIVE)

function hex_to_ascii(str1) {
	var hex  = str1.toString();
	var str = '';
	for (var n = 0; n < hex.length; n += 2) {
		str += String.fromCharCode(parseInt(hex.substr(n, 2), 16));
	}
	return str;
 }

async function revertReason() {
    const txHash = '0x816085bf0dae182d246b0ba862cf2802b5c3338aa950b0963c596b8109e822ab'
    const tx = await provider.getTransaction(txHash)
    const code = await provider.call(tx, tx.blockNumber)
    console.log(code)
    let reason = hex_to_ascii(code.slice(138))
    console.log('revert reason:', reason)
}

async function parseLogs() {
    const receipt = await provider.getTransactionReceipt('0x17fcebfe8f78c64988c3637953918ae584ef2266a7abe81286adff640a0c31e1')
    const events = parseLog(receipt.logs.slice(0, 1), require('../artifacts/contracts/orderbooks/OrderBook.sol/OrderBook.json').abi)
    console.log(events)
}

const orderbookSlice = async () => {
    const { orders, bids, asks } = await exchange.fetchOrderBook(0)
    console.log({ bids: bids.slice(0, 30), asks: asks.slice(0, 50) })
}

const orderMatchingError = async () => {
    let events = (await orderBook.queryFilter(orderBook.filters.OrderMatchingError('0x4ca1955956ebb5c3984fcbdfccf136e642c74548ed58daa132c84298f5825644')))
    console.log(events)
}

revertReason()
