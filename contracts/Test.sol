// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

contract Test {
    function a(int256 b) external pure returns(uint) {
        return uint(b);
    }

    function c(uint b) external pure returns(uint) {
        return b;
    }

    function d() external pure returns(int256) {
        return type(int256).max + 1;
    }
}
