require("@nomiclabs/hardhat-waffle");
require('@nomiclabs/hardhat-web3')
require('hardhat-spdx-license-identifier')
// require("@nomiclabs/hardhat-vyper");

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
