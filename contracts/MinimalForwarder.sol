// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { MinimalForwarderUpgradeable } from "@openzeppelin/contracts-upgradeable/metatx/MinimalForwarderUpgradeable.sol";

contract MinimalForwarder is MinimalForwarderUpgradeable {
    function intialize() external {
        __MinimalForwarder_init(); // has the initializer modifier
    }

    function metaExecute(ForwardRequest calldata req, bytes calldata signature)
        external
        payable
    {
        (bool success, bytes memory returnData) = execute(req, signature);
        require(success, string(abi.encodePacked("META_EXEC_FAILED: ", returnData)));
    }
}
