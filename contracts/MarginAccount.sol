pragma solidity 0.8.4;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./VUSD.sol";
import "hardhat/console.sol";

contract MarginAccount is Ownable {
    using SafeERC20 for IERC20;

    uint8 constant vUSDidx = 0;

    IClearingHouse public clearingHouse;

    struct Collateral {
        IERC20 token;
        IOracle oracle;
        uint8 decimals;
    }
    Collateral[] public supportedCollateral;

    // supportedCollateral index => trader => balance
    mapping(uint => mapping(address => uint256)) public margin;

    VUSD public vUSD;
    IERC20 public usdc;
    mapping(address => int256) public vUSDBalance;

    modifier onlyClearingHouse() {
        require(msg.sender == address(clearingHouse), "Only clearingHouse");
        _;
    }

    constructor(address _vUSD, address _usdc) {
        vUSD = VUSD(_vUSD);
        usdc = IERC20(_usdc);
    }

    // Add Margin functions

    function addUSDCMargin(uint256 amount) external {
        address trader = msg.sender;
        usdc.safeTransferFrom(trader, address(this), amount);
        vUSDBalance[trader] += int(amount);
    }

    function addVUSDMargin(uint256 amount) external {
        address trader = msg.sender;
        IERC20(address(vUSD)).safeTransferFrom(trader, address(this), amount);
        vUSDBalance[trader] += int(amount);
    }

    function addMargin(uint idx, uint256 amount) external {
        address trader = msg.sender;
        supportedCollateral[idx].token.safeTransferFrom(trader, address(this), amount);
        margin[idx][trader] += amount; // take care of decimals, just using 6 rn for vusd and usdc
    }

    // Withdraw functions

    function withdrawVusd(uint256 amount, bool redeemForUSDC) external {
        address trader = msg.sender;
        clearingHouse.updatePositions(trader);
        require(vUSDBalance[trader] > int(amount), "Insufficient vUSD balance");
        vUSDBalance[trader] -= int(amount);
        if (redeemForUSDC) {
            // add to withdrawal Q
        } else {
            uint bal = vUSD.balanceOf(address(this));
            if (bal < amount) {
                vUSD.mint(address(this), amount - bal);
            }
            IERC20(address(vUSD)).safeTransfer(trader, amount);
        }
    }

    function removeMargin(uint idx, uint256 amount) external {
        address trader = msg.sender;
        clearingHouse.updatePositions(trader);
        require(vUSDBalance[trader] >= 0, "Cannot remove margin when vUSD balance is negative");
        margin[idx][trader] -= amount; // will revert if insufficient balance
        // if there are open positions, verifyMaintenanceMargin
        require(clearingHouse.isAboveMaintenanceMargin(trader), "CH: Below Maintenance Margin");
        supportedCollateral[idx].token.safeTransfer(trader, amount);
    }

    function realizePnL(address trader, int256 realizedPnl) onlyClearingHouse external {
        // console.logInt(realizedPnl);
        // -ve PnL will reduce balance
        vUSDBalance[trader] += realizedPnl;
    }

    // View

    function getNormalizedMargin(address trader) external view returns(int256) {
        uint256 normMargin;
        Collateral[] memory _collaterals = supportedCollateral;
        for (uint i = 0; i < _collaterals.length; i++) {
            Collateral memory _collateral = _collaterals[i];
            uint256 _margin = (margin[i][trader] * uint(_collateral.oracle.price())) / 10 ** _collateral.decimals;
            normMargin += _margin;
        }
        // uint -> int256 is unsafe typecast @todo fix it
        return int256(normMargin) + vUSDBalance[trader]; // scaled by 6 decimals
    }

    // privileged

    function setClearingHouse(IClearingHouse _clearingHouse) external onlyOwner {
        clearingHouse = _clearingHouse;
    }

    function addCollateral(address _coin, address _oracle) external onlyOwner {
        require(_coin != address(usdc) && _coin != address(vUSD), "Invalid collateral");
        supportedCollateral.push(
            Collateral({
                token: IERC20(_coin),
                oracle: IOracle(_oracle),
                decimals: ERC20Detailed(_coin).decimals()
            })
        );
    }
}

interface IOracle {
    function price() external view returns(int256);
}

interface IClearingHouse {
    function isAboveMaintenanceMargin(address trader) external view returns(bool);
    function updatePositions(address trader) external;
}

interface ERC20Detailed {
    function decimals() external view returns (uint8);
}
