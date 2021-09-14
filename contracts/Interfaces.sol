// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

interface IOracle {
    function getUnderlyingPrice(address asset) external view returns(int256);
    function getUnderlyingTwapPrice(address asset, uint256 intervalInSeconds) external view returns (int256);
}

interface IRegistry {
    function getOracle() external view returns(address);
}
