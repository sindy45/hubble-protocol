// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { IClearingHouse,IMarginAccount } from "./Interfaces.sol";

contract HubbleViewer {
    IClearingHouse public clearingHouse;
    IMarginAccount public marginAccount;

    constructor(
        IClearingHouse _clearingHouse,
        IMarginAccount _marginAccount
    ) {
        clearingHouse = _clearingHouse;
        marginAccount = _marginAccount;
    }

    function getMarginFraction(address[] calldata traders) external view returns(uint256[] memory fractions) {
        fractions = new uint256[](traders.length);
        for (uint i = 0; i < traders.length; i++) {
            fractions[i] = clearingHouse.getMarginFraction(traders[i]);
        }
    }

    function isLiquidatable(address[] calldata traders)
        external
        view
        returns(bool[] memory _isLiquidatable, uint[] memory debt)
    {
        _isLiquidatable = new bool[](traders.length);
        debt = new uint[](traders.length);
        for (uint i = 0; i < traders.length; i++) {
            (_isLiquidatable[i], debt[i],) = marginAccount.isLiquidatable(traders[i]);
        }
    }
}