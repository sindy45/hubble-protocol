// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "../AMM.sol";

contract TestAmm is AMM {
    using SafeCast for uint256;

    constructor(address _clearingHouse, uint _unbondRoundOff) AMM(_clearingHouse) {}

    function getOracleBasedMarginFraction(address trader, int256 margin)
        external
        view
        returns (int oracleBasedNotional, int256 oracleBasedUnrealizedPnl, int256 marginFraction)
    {
        Position memory _taker = positions[trader];
        return _getOracleBasedMarginFraction(margin, _taker.openNotional, _taker.size);
    }
}
