// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import "./Interfaces.sol";

contract InsuranceFund is Ownable, Initializable, ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public vusd;
    address public marginAccount;
    uint public pendingObligation;

    modifier onlyMarginAccount() {
        require(msg.sender == address(marginAccount), "Only Margin Account");
        _;
    }

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function initialize(address _registry) external initializer {
        IRegistry registry = IRegistry(_registry);
        vusd = IERC20(registry.vusd());
        marginAccount = registry.marginAccount();
    }

    function seizeBadDebt(uint amount) external onlyMarginAccount {
        settlePendingObligation();
        uint bal = vusd.balanceOf(address(this));
        if (bal < amount) {
            pendingObligation += (amount - bal);
            amount = bal;
        }
        vusd.safeTransfer(msg.sender, amount);
    }

    function settlePendingObligation() public {
        uint toTransfer = Math.min(vusd.balanceOf(address(this)), pendingObligation);
        pendingObligation -= toTransfer;
        vusd.safeTransfer(marginAccount, toTransfer);
    }

    function deposit(uint _amount) external {
        uint _pool = balance();
        uint _totalSupply = totalSupply();
        if (_totalSupply == 0 && _pool > 0) { // trading fee accumulated while there were no IF LPs
            vusd.safeTransfer(owner(), _pool);
            _pool = 0;
        }

        vusd.safeTransferFrom(msg.sender, address(this), _amount);
        uint shares = 0;
        if (_pool == 0) {
            shares = _amount;
        } else {
            shares = _amount * _totalSupply / _pool;
        }
        _mint(msg.sender, shares);
    }

    function balance() public view returns (uint) {
        return vusd.balanceOf(address(this));
    }

    // Privileged

    function syncDeps(IRegistry registry) public onlyOwner {
        marginAccount = registry.marginAccount();
        vusd = IERC20(registry.vusd());
    }
}
