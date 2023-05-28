const ethers = require('ethers')

const { Exchange } = require('./exchange');

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY_MAKER, provider);
const exchange = new Exchange(provider)

const cancelAllOrders = async () => {
    console.log(signer.address)
    return exchange.cancelAllOrders(signer);
};

cancelAllOrders();
