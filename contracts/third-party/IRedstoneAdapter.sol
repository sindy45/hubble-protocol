// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

interface IRedstoneAdapter {
    function getValueForDataFeedAndRound(bytes32 dataFeedId, uint256 roundId) external view returns (uint256 dataFeedValue);
    function getLatestRoundParams() external view returns ( uint256 latestRoundId, uint128 latestRoundDataTimestamp, uint128 latestRoundBlockTimestamp);
}
