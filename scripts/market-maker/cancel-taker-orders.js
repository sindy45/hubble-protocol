const ethers = require('ethers')

const { Exchange } = require('./exchange')

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY_TAKER, provider);
const exchange = new Exchange(provider)

const cancelAllOrders = async () => {
    return exchange.cancelAllOrders(signer);
};

async function showNonce() {
    console.log(await signer.getTransactionCount())
}

cancelAllOrders();
