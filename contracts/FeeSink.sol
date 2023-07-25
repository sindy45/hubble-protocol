// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { HubbleBase } from "./legos/HubbleBase.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    IAMM,
    IERC20,
    IERC20FlexibleSupply
} from "./Interfaces.sol";
import { IClearingHouse } from "./Interfaces.sol";

interface IFeeSink {
    function distributeFunds() external;
}

/**
 * @title This contract is used to distribute fee between the treasury and insurance fund.
 * Fee is collected by clearingHouse in vusd and credited to FeeSink contract's address.
 * @notice Most notable operations include distributeFunds
*/
contract FeeSink is IFeeSink, HubbleBase {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    IClearingHouse public immutable clearingHouse;
    IERC20FlexibleSupply public immutable vusd;
    address public immutable insuranceFund;
    address public treasury;

    mapping(address => bool) public validFundsDistributors; // accounts that can execute distributeFunds
    /**
    * @notice imposes a upperLimit on ratio of totalFee which can be sent to insuranceFund
    * @dev precision 1e6 = 100%
    */
    uint public maxFeePercentageForInsuranceFund;
    /**
    * @notice target ratio of insuranceFundBalance to totalOpenInterest(across all markets)
    * @dev precision 1e6 = 100%
    */
    uint public insuranceFundToOpenInterestTargetRatio;

    uint[50] private __gap;

    modifier onlyGovernanceOrValidFundsDistributor() {
        require(_msgSender() == governance() || validFundsDistributors[_msgSender()], "FeeSink: not allowed execute distributeFunds");
        _;
    }

    constructor(address _insuranceFund, address _vusd, address _clearingHouse) {
        insuranceFund = _insuranceFund;
        vusd = IERC20FlexibleSupply(_vusd);
        clearingHouse = IClearingHouse(_clearingHouse);
    }

    function initialize(address _governance, address _treasury) external initializer {
        _setGovernace(_governance);
        treasury = _treasury;
        maxFeePercentageForInsuranceFund = 1e5; // 10 %
        insuranceFundToOpenInterestTargetRatio = 4e5; // 40%
        validFundsDistributors[address(clearingHouse)] = true;
    }

    /**
     * @notice Distributes the funds in the contract to the insurance fund and treasury.
     * let x = Insurance fund balance (IF) / Open interest (OI), y = target IF / OI ratio, z = maxFeePercentage to insurance fund
     * if x < y, funds are distributed between insurance fund and treasury as per below formula
     * insurance fund share = (1 - x / y) * z * feeAmount
     * rest is sent to the treasury.
     * if either y or z is 0, all funds are sent to the treasury.
     * if x >= y, all funds are sent to the treasury.
     * Can only be called by the governance.
     * @dev reverts if no funds are available to distribute.
    */
    function distributeFunds() external onlyGovernanceOrValidFundsDistributor {
        uint balance = vusd.balanceOf(address(this));
        if (balance == 0) {
            return;
        }
        (uint insuranceFundFee, uint treasuryFee) = _getFeeDistributionBetweenInsuranceFundAndTreasury(balance);
        IERC20(address(vusd)).safeTransfer(insuranceFund, insuranceFundFee);
        IERC20(address(vusd)).safeTransfer(treasury, treasuryFee);
    }

    function _getFeeDistributionBetweenInsuranceFundAndTreasury(uint _feeAmount) internal view returns (uint insuranceFundFee, uint treasuryFee) {
        if (maxFeePercentageForInsuranceFund == 0 || insuranceFundToOpenInterestTargetRatio == 0) {
            return (0, _feeAmount);
        }

        uint openInterest = calculateNetOpenInterest();
        // if openInterest is zero, no need to send money to insuranceFund
        if (openInterest == 0) {
            return (0, _feeAmount);
        }

        uint vusdPriceInUSD = uint(clearingHouse.amms(0).oracle().getUnderlyingPrice(address(vusd)));
        uint insuranceFundBalance = vusd.balanceOf(insuranceFund) * vusdPriceInUSD / 1e6;
        uint insuranceFundToOpenInterestRatio = (insuranceFundBalance * 1e6) / openInterest;
        if (insuranceFundToOpenInterestRatio >= insuranceFundToOpenInterestTargetRatio) {
            return (0, _feeAmount);
        }

        insuranceFundFee = (insuranceFundToOpenInterestTargetRatio - insuranceFundToOpenInterestRatio) * maxFeePercentageForInsuranceFund * _feeAmount / (insuranceFundToOpenInterestTargetRatio * 1e6);
        treasuryFee = _feeAmount - insuranceFundFee;
    }

    function calculateNetOpenInterest() public view returns (uint netOpenInterest) {
        IAMM[] memory amms = clearingHouse.getAMMs();
        for (uint i = 0; i < amms.length; i++) {
            IAMM amm = amms[i];
            netOpenInterest += amm.getUnderlyingPrice() * amm.openInterestNotional() / 1e18;
        }
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function setTreasury(address _treasury) external onlyGovernance {
        treasury = _treasury;
    }

    function setMaxFeePercentageForInsuranceFund(uint _maxFeePercentageForInsuranceFund) external onlyGovernance {
        maxFeePercentageForInsuranceFund = _maxFeePercentageForInsuranceFund;
    }

    function setInsuranceFundToOpenInterestTargetRatio(uint _insuranceFundToOpenInterestTargetRatio) external onlyGovernance {
        insuranceFundToOpenInterestTargetRatio = _insuranceFundToOpenInterestTargetRatio;
    }

    function setValidFundsDistributors(address _fundsDistributor, bool _valid) external onlyGovernance {
        validFundsDistributors[_fundsDistributor] = _valid;
    }
 }
