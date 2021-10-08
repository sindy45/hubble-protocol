require("@nomiclabs/hardhat-waffle");
require('@nomiclabs/hardhat-web3')
require('hardhat-spdx-license-identifier')
// require("@nomiclabs/hardhat-vyper");

const PRIVATE_KEY = `0x${process.env.PRIVATE_KEY || 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'}`

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
    solidity: "0.8.4",
    vyper: {
        version: "0.2.12",
    },
    networks: {
        local: {
            url: 'http://localhost:8545',
            chainId: 1337
        },
        hardhat: {
            chainId: 1337
        },
        fuji: {
            url: 'https://api.avax-test.network/ext/bc/C/rpc',
            chainId: 43113,
            accounts: [ PRIVATE_KEY ]
        },
    },
    mocha: {
        timeout: 0
    },
    etherscan: {
        apiKey: `${process.env.ETHERSCAN || ''}`
    },
    spdxLicenseIdentifier: {
        runOnCompile: true
    }
};
