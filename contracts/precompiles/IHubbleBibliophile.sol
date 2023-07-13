// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IClearingHouse, IAMM } from "../Interfaces.sol";

interface IHubbleBibliophile {
    function getNotionalPositionAndMargin(address trader, bool includeFundingPayments, uint8 mode)
        external
        view
        returns(uint256 notionalPosition, int256 margin);
    function getPositionSizes(address trader) external view returns(int[] memory posSizes);
    function getPositionSizesAndUpperBoundsForMarkets(address trader) external view returns(int[] memory posSizes, uint[] memory upperBounds);
}

/**
 * @title Fallback code if precompile is not available
 */
contract Bibliophile is IHubbleBibliophile {

    IClearingHouse public immutable clearingHouse;

    constructor(address _clearingHouse) {
        clearingHouse = IClearingHouse(_clearingHouse);
    }

    function getPositionSizes(address trader) external view returns(int[] memory posSizes) {
        (posSizes,) = getPositionSizesAndUpperBoundsForMarkets(trader);
    }

    function getPositionSizesAndUpperBoundsForMarkets(address trader) override public view returns(int[] memory posSizes, uint[] memory upperBounds) {
        uint numAmms = clearingHouse.getAmmsLength();
        posSizes = new int[](numAmms);
        upperBounds = new uint[](numAmms);
        for (uint i; i < numAmms; ++i) {
            IAMM amm = IAMM(clearingHouse.amms(i));
            (posSizes[i],,,) = amm.positions(trader);
            uint spreadLimit = amm.maxOracleSpreadRatio();
            uint256 oraclePrice = amm.getUnderlyingPrice();
            upperBounds[i] = oraclePrice * (1e6 + spreadLimit) / 1e6;
        }
    }

    function getNotionalPositionAndMargin(address trader, bool includeFundingPayments, uint8 mode)
        external
        view
        returns(uint256 notionalPosition, int256 margin) {
            return clearingHouse.getNotionalPositionAndMarginVanilla(trader, includeFundingPayments, IClearingHouse.Mode(mode));
        }
}
