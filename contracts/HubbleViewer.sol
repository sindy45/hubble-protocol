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

    function getNotionalPositionAndMargin(address[] calldata traders)
        external
        view
        returns(uint256[] memory notionalPositions, int256[] memory margins)
    {
        notionalPositions = new uint256[](traders.length);
        margins = new int256[](traders.length);
        for (uint i = 0; i < traders.length; i++) {
            (notionalPositions[i], margins[i]) = clearingHouse.getNotionalPositionAndMargin(traders[i], true /* includeFundingPayments */);
        }
    }

    function liquidatationStatus(address[] calldata traders)
        external
        view
        returns(bool[] memory isLiquidatable, uint[] memory repayAmount, uint[] memory incentivePerDollar)
    {
        isLiquidatable = new bool[](traders.length);
        repayAmount = new uint[](traders.length);
        incentivePerDollar = new uint[](traders.length);
        for (uint i = 0; i < traders.length; i++) {
            (isLiquidatable[i], repayAmount[i], incentivePerDollar[i]) = marginAccount.isLiquidatable(traders[i], true);
        }
    }
}
