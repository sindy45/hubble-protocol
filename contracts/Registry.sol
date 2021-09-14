// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

contract Registry {
    address public oracle;

    constructor(address _oracle) {
        oracle = _oracle;
    }

    function getOracle() external view returns(address) {
        return oracle;
    }
}
