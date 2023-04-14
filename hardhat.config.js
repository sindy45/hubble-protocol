require("@nomiclabs/hardhat-waffle");
require('@nomiclabs/hardhat-web3')
require('hardhat-spdx-license-identifier')
require('solidity-coverage')
require("hardhat-gas-reporter")
require('hardhat-docgen')
require('hardhat-contract-sizer')
require("@tenderly/hardhat-tenderly");
require("@nomiclabs/hardhat-etherscan");

const fs = require('fs');
const os = require('os');
const path = require('path');

// get the name fo the network
const network = process.env.HARDHAT_NETWORK || 'hardhat';

let chainId
if (network === 'subnet') {
    const filePath = path.join(os.homedir(), '.hubblenet.json')
    const fileData = fs.readFileSync(filePath, 'utf-8');
    const jsonData = JSON.parse(fileData);
    chainId = jsonData.chain_id;
}

const PRIVATE_KEY = `0x${process.env.PRIVATE_KEY || 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'}`

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
    solidity: {
        version: "0.8.9",
        settings: {
            optimizer: {
                enabled: true,
                runs: 10000
            }
        }
    },
    networks: {
        /*** When forking fuji locally ***/
        // local: {
        //     url: 'http://localhost:8545',
        //     chainId: 31337
        // },
        // hardhat: {
        //     forking: {
        //         url: 'https://api.avax-test.network/ext/bc/C/rpc',
        //         chainId: 43113
        //     }
        // },
        local: {
            url: 'http://127.0.0.1:8545',
            chainId: 321123,
        },
        hardhat: {
            chainId: 321123
        },
        subnet: {
            url: `http://127.0.0.1:9650/ext/bc/${chainId}/rpc`,
            chainId: 321123,
            throwOnTransactionFailures: true,
            gasLimit: 5000000,
            accounts: {
                mnemonic: "test test test test test test test test test test test junk"
            }
        },
        fujinet: {
            url: 'https://internal-hubblenet-rpc.hubble.exchange/ext/bc/zMahcey2Yk8jiHdVr4sCVrc4gQKhpyaWCtQK55PsmtoGqnBfY/rpc',
            chainId: 321123,
            throwOnTransactionFailures: true,
            gasLimit: 5000000
        },
        fuji: {
            url: 'https://internal-hubblenet-rpc.hubble.exchange/ext/bc/2ErDhAugYgUSwpeejAsCBcHY4MzLYZ5Y13nDuNRtrSWjQN5SDM/rpc', // changes on every fresh run
            chainId: 321123,
            throwOnTransactionFailures: true,
            gasLimit: 5000000,
            accounts: {
                mnemonic: "test test test test test test test test test test test junk"
            }
        },
        cchain: {
            url: 'https://api.avax.network/ext/bc/C/rpc',
            chainId: 43114,
            throwOnTransactionFailures: true,
            gasLimit: 6000000,
            accounts: [ PRIVATE_KEY ]
        },
    },
    etherscan: {
        apiKey: {
            avalancheFujiTestnet: process.env.SNOWTRACE || '',
            avalanche: process.env.SNOWTRACE || '',
        }
    },
    spdxLicenseIdentifier: {
        runOnCompile: true
    },
    gasReporter: {
        currency: 'USD',
        gasPrice: 25,
        coinmarketcap: '554a6764-aae9-440e-852b-63e3c66c20d7',
        token: 'AVAX',
        enabled: process.env.REPORT_GAS ? true : false
    },
    docgen: {
        clear: true,
    },
    tenderly: {
        project: "hubble",
        username: "atvanguard",
    },
    mocha: {
        timeout: 0
    }
};
