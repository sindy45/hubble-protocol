// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "./Utils.sol";

contract DeployContracts is Utils {

    function setUp() public {
        setupContracts();
    }

    function testDeployment() public {
        // husd
        assertEq(husd.name(), 'Hubble USD');
        assertEq(husd.symbol(), 'hUSD');
        assertEq(address(husd.reserveToken()), address(usdc));

        // marginAccount
        assertEq(marginAccount.isTrustedForwarder(address(forwarder)), true);
        assertEq(marginAccount.governance(), governance);
        assertEq(address(marginAccount.vusd()), address(husd));
        assertEq(address(marginAccount.clearingHouse()), address(clearingHouse));
        assertEq(address(marginAccount.oracle()), address(oracle));
        assertEq(address(marginAccount.insuranceFund()), address(insuranceFund));
        assertEq(marginAccount.liquidationIncentive(), 5e4);

        // insuranceFund
        assertEq(insuranceFund.governance(), governance);
        assertEq(address(insuranceFund.vusd()), address(husd));

        // orderBook
        assertEq(address(orderBook.clearingHouse()), address(clearingHouse));
        assertEq(orderBook.governance(), governance);

        // clearingHouse
        assertEq(clearingHouse.isTrustedForwarder(address(forwarder)), true);
        assertEq(clearingHouse.governance(), governance);
        assertEq(clearingHouse.feeSink(), feeSink);
        assertEq(address(clearingHouse.marginAccount()), address(marginAccount));
        assertEq(address(clearingHouse.orderBook()), address(orderBook));
        assertEq(address(clearingHouse.vusd()), address(husd));
        assertEq(address(clearingHouse.hubbleReferral()), address(hubbleReferral));
        assertEq(clearingHouse.maintenanceMargin(), 1e5);
        assertEq(clearingHouse.minAllowableMargin(), 2e5);
        assertEq(clearingHouse.takerFee(), 500);
        assertEq(clearingHouse.makerFee(), 500);
        assertEq(clearingHouse.referralShare(), 50);
        assertEq(clearingHouse.tradingFeeDiscount(), 100);
        assertEq(clearingHouse.liquidationPenalty(), 5e4);

        // amm
        assertEq(amm.clearingHouse(), address(clearingHouse));
        assertEq(amm.underlyingAsset(), address(wavax));
        assertEq(address(amm.oracle()), address(oracle));
        assertEq(amm.minSizeRequirement(), 5e18);

        // oracle
        assertEq(oracle.getUnderlyingPrice(address(wavax)), 20 * 1e6);
        assertEq(oracle.getUnderlyingTwapPrice(address(wavax), 0), 20 * 1e6);
    }
}
