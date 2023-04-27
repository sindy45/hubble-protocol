// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import "../ClearingHouse.sol";
import "../Interfaces.sol";
import "hardhat/console.sol";

contract TestClearingHouse is ClearingHouse {
    using SafeCast for uint256;
    using SafeCast for int256;

    function openPosition2(uint ammIndex, int baseAssetQuantity, uint quote) external {
        uint price;
        if (quote == 0 || quote == type(uint).max) {
            price = amms[ammIndex].lastPrice();
        } else {
            price = quote * 1e18 / uint(abs(baseAssetQuantity));
        }
        openPosition3(ammIndex, baseAssetQuantity, price);
    }

    function openPosition3(uint ammIndex, int baseAssetQuantity, uint price) public {
        uint salt = _blockTimestamp();
        IOrderBook.Order memory order = IOrderBook.Order(ammIndex, _msgSender(), baseAssetQuantity, price, salt, false);
        _openPosition(order, order.baseAssetQuantity, order.price, IOrderBook.OrderExecutionMode.Taker);
    }

    function closePosition(uint ammIndex) external {
        address trader = _msgSender();
        uint price = amms[ammIndex].lastPrice();
        uint salt = _blockTimestamp();
        (int baseAssetQuantity,,,) = amms[ammIndex].positions(trader);
        IOrderBook.Order memory order = IOrderBook.Order(ammIndex,_msgSender(), -baseAssetQuantity, price, salt, true);
        _openPosition(order, order.baseAssetQuantity, order.price, IOrderBook.OrderExecutionMode.Taker);
    }

    function liquidate2(address trader) external {
        uint price = amms[0].lastPrice();
        (int size,,, uint liquidationThreshold) = amms[0].positions(trader);
        liquidationThreshold = Math.min(liquidationThreshold, abs(size).toUint256());

        int fillAmount = liquidationThreshold.toInt256();
        if (size < 0) {
            fillAmount = -liquidationThreshold.toInt256();
        }
        updatePositions(trader);
        _liquidateSingleAmm(trader, 0, price, fillAmount);
    }

    function setAMM(uint idx, address amm) external {
        amms[idx] = IAMM(amm);
    }
}
