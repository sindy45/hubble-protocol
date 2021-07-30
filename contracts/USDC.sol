pragma solidity 0.8.4;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract USDC is ERC20 {

    constructor() ERC20("USDC", "USDC") {}

    function mint(address account, uint amount) external {
        _mint(account, amount);
    }

    function decimals() public view override returns (uint8) {
        return 6;
    }
}

