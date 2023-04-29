// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

interface INativeMinter {
    // Mint [amount] number of native coins and send to [addr]
    function mintNativeCoin(address addr, uint256 amount) external;
}
