// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { LZEndpointMock } from "@layerzerolabs/solidity-examples/contracts/mocks/LZEndpointMock.sol";

contract TestLZEndpointMock is LZEndpointMock {
    constructor(uint16 _chainId) LZEndpointMock(_chainId) {}
}
