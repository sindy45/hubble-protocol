// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

contract Registry {
    address public immutable oracle;
    address public immutable clearingHouse;
    address public immutable insuranceFund;
    address public immutable marginAccount;
    address public immutable vusd;

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
