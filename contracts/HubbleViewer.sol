// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { IClearingHouse } from "./Interfaces.sol";

contract HubbleViewer {
    IClearingHouse public clearingHouse;

    constructor(IClearingHouse _clearingHouse) {
        clearingHouse = _clearingHouse;
    }

    function getMarginFraction(address[] calldata traders) external view returns(uint256[] memory fractions) {
        fractions = new uint256[](traders.length);
        for (uint i = 0; i < traders.length; i++) {
            fractions[i] = clearingHouse.getMarginFraction(traders[i]);
        }
    }
}
