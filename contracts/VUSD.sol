pragma solidity 0.8.4;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract VUSD is ERC20 {

    constructor() ERC20("vUSD", "vUSD") {}

    function mint(address account, uint amount) external /* onlyMarginAccount */ {
        _mint(account, amount);
    }

    function decimals() public view override returns (uint8) {
        return 6;
    }
}
