// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

contract Oracle {
    mapping(address => int256) prices;
    mapping(address => int256) twapPrices;

    function getUnderlyingPrice(address underlying) external view returns(int256) {
        return prices[underlying];
    }

    function getUnderlyingTwapPrice(address underlying, uint256 /* intervalInSeconds */) public view returns (int256) {
        return twapPrices[underlying];
    }

    function setPrice(address underlying, int256 _price) external {
        prices[underlying] = _price;
    }

    function setTwapPrice(address underlying, int256 _price) external {
        twapPrices[underlying] = _price;
    }
}

