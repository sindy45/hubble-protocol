// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "../AMM.sol";

contract TestAmm is AMM {
    using SafeCast for uint256;

    constructor(address _clearingHouse, uint _unbondRoundOff) AMM(_clearingHouse, _unbondRoundOff) {}

    function getOracleBasedMarginFraction(address trader, int256 margin)
        external
        view
        returns (int oracleBasedNotional, int256 oracleBasedUnrealizedPnl, int256 marginFraction)
    {
        Maker memory _maker = _makers[trader];
        Position memory _taker = positions[trader];
        (,int256 size,,uint256 openNotional) = vamm.get_notional(
            _maker.dToken,
            _maker.vUSD,
            _maker.vAsset,
            _taker.size,
            _taker.openNotional
        );
        return _getOracleBasedMarginFraction(trader, margin, openNotional, size);
    }
}
