// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20PresetMinterPauser } from "@openzeppelin/contracts/token/ERC20/presets/ERC20PresetMinterPauser.sol";

import "hardhat/console.sol";

contract VUSD is ERC20PresetMinterPauser {
    using SafeERC20 for IERC20;

    struct Withdrawal {
        address usr;
        uint amount;
    }

    Withdrawal[] public withdrawals;

    /// @dev withdrawals will start processing at withdrawals[start]
    uint start;

    /// @dev Constrained by block gas limit
    uint maxWithdrawalProcesses = 100;

    /// @notice vUSD is backed 1:1 with reserveToken (USDC)
    IERC20 public reserveToken;

    constructor(address _reserveToken) ERC20PresetMinterPauser("Hubble-virtual-usd", "vUSD") {
        require(_reserveToken != address(0), "vUSD: null _reserveToken");
        reserveToken = IERC20(_reserveToken);
    }

    function mintWithReserve(address to, uint amount) external {
        reserveToken.safeTransferFrom(msg.sender, address(this), amount);
        _mint(to, amount);
    }

    function withdraw(uint amount) external {
        burn(amount);
        withdrawals.push(Withdrawal(msg.sender, amount));
    }

    function processWithdrawals() external {
        uint reserve = reserveToken.balanceOf(address(this));
        require(reserve >= withdrawals[start].amount, 'Cannot process withdrawals at this time: Not enough balance');
        uint i = start;
        while (i < withdrawals.length && (i - start) <= maxWithdrawalProcesses) {
            Withdrawal memory withdrawal = withdrawals[i];
            if (reserve < withdrawal.amount) {
                break;
            }
            reserveToken.safeTransfer(withdrawal.usr, withdrawal.amount);
            reserve -= withdrawal.amount;
            i += 1;
        }
        start = i;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
