// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { AggregatorV3Interface } from "../Interfaces.sol";
contract TestPriceFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }
}
