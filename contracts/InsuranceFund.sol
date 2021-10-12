// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { AccessControlEnumerable } from "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { ERC20PresetMinterPauserUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/presets/ERC20PresetMinterPauserUpgradeable.sol";

import { VanillaGovernable } from "./Governable.sol";
import "./Interfaces.sol";

contract InsuranceFund is VanillaGovernable, ERC20PresetMinterPauserUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant SEIZE_ROLE = keccak256("SEIZE_ROLE");

    IERC20 public vusd;
    address public marginAccount;
    uint public pendingObligation;

    modifier onlyMarginAccount() {
        require(msg.sender == address(marginAccount), "Only Margin Account");
        _;
    }

    function init(address _governance) external {
        super.initialize("Hubble-Insurance-Fund", "HIF"); // has initializer modifier
        _setGovernace(_governance);
    }

    function seizeBadDebt(uint amount) external {
        require(hasRole(SEIZE_ROLE, msg.sender), "InsuranceFund: must have seize role");
        settlePendingObligation();
        uint bal = vusd.balanceOf(address(this));
        if (bal < amount) {
            pendingObligation += (amount - bal);
            amount = bal;
        }
        if (amount > 0) {
            vusd.safeTransfer(marginAccount, amount);
        }
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
            vusd.safeTransfer(governance, _pool);
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

    // Governance

    function syncDeps(IRegistry _registry) public onlyGovernance {
        vusd = IERC20(_registry.vusd());

        address newMarginAccount = _registry.marginAccount();
        if (marginAccount != address(0)) {
            revokeRole(SEIZE_ROLE, marginAccount);
        }
        marginAccount = newMarginAccount;

        // @todo revoke SEIZE_ROLE for oldClearingHouse
        _setupRole(SEIZE_ROLE, marginAccount);
        _setupRole(SEIZE_ROLE, _registry.clearingHouse());
    }
}
