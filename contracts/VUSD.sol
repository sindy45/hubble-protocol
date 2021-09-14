// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20PresetMinterPauser } from "@openzeppelin/contracts/token/ERC20/presets/ERC20PresetMinterPauser.sol";

contract VUSD is ERC20PresetMinterPauser {
    using SafeERC20 for IERC20;

    IERC20 public reserveToken;

    constructor(address _reserveToken) ERC20PresetMinterPauser("vUSD", "vUSD") {
        reserveToken = IERC20(_reserveToken);
    }

    function mintWithReserve(address to, uint amount) external {
        reserveToken.safeTransferFrom(msg.sender, address(this), amount);
        _mint(to, amount);
    }

    function mint(address to, uint amount) public override {
        super.mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
