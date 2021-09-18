// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

contract Registry {
    address public oracle;
    address public clearingHouse;
    address public insuranceFund;
    address public marginAccount;
    address public vusd;

    constructor(
        address _oracle,
        address _clearingHouse,
        address _insuranceFund,
        address _marginAccount,
        address _vusd
    ) {
        oracle = _oracle;
        clearingHouse = _clearingHouse;
        insuranceFund = _insuranceFund;
        marginAccount = _marginAccount;
        vusd = _vusd;
    }
}
