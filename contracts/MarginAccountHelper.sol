// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { VUSD } from "./VUSD.sol";
import { IMarginAccount, IWAVAX } from "./Interfaces.sol";

contract MarginAccountHelper {
    using SafeERC20 for IERC20;
    using SafeERC20 for IWAVAX;

    uint constant VUSD_IDX = 0;
    uint constant WAVAX_IDX = 1; // assumes wavax index = 1

    IMarginAccount marginAccount;
    VUSD vusd;
    IWAVAX public wavax;

    constructor(address _marginAccount, address _vusd, address _wavax) {
        marginAccount = IMarginAccount(_marginAccount);
        vusd = VUSD(_vusd);
        wavax = IWAVAX(_wavax);

        IERC20(_vusd).safeApprove(_marginAccount, type(uint).max);
        wavax.safeApprove(_marginAccount, type(uint).max);
    }

    function addVUSDMarginWithReserve(uint256 amount) external payable {
        vusd.mintWithReserve{value: msg.value}(address(this), amount);
        marginAccount.addMarginFor(VUSD_IDX, amount, msg.sender);
    }

    function addMarginWithAvax() external payable {
        uint amount = msg.value;
        wavax.deposit{value: amount}();
        marginAccount.addMarginFor(WAVAX_IDX, amount, msg.sender);
    }
}
