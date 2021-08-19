pragma solidity 0.8.4;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20Mintable is ERC20 {

    uint8 _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals)
        ERC20(name_, symbol_)
    {
        _decimals = decimals;
    }

    function mint(address account, uint amount) external {
        _mint(account, amount);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

