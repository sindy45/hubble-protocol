// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

interface IOrderHandler {
    enum OrderStatus {
        Invalid,
        Placed,
        Filled,
        Cancelled
    }

    function updateOrder(bytes calldata data, bytes calldata metadata) external;
}
