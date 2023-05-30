// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;
// pragma solidity 0.8.4;

interface IHubbleBibliophile {
    function getNotionalPositionAndMargin(address trader, bool includeFundingPayments, uint8 mode)
        external
        view
        returns(uint256 notionalPosition, int256 margin);

    function getPositionSizes(address trader) external view returns(int[] memory posSizes);
}
