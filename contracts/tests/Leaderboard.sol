// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IClearingHouse, IMarginAccount, IAMM, IHubbleViewer } from "../Interfaces.sol";

contract Leaderboard {

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable marginAccount;
    IHubbleViewer  public immutable hubbleViewer;

    constructor(
        IHubbleViewer _hubbleViewer
    ) {
        clearingHouse = _hubbleViewer.clearingHouse();
        marginAccount = _hubbleViewer.marginAccount();
        hubbleViewer = _hubbleViewer;
    }

    function leaderboard(address[] calldata traders)
        external
        view
        returns(int[] memory makerMargins, int[] memory takerMargins)
    {
        uint numTraders = traders.length;
        makerMargins = new int[](numTraders);
        takerMargins = new int[](numTraders);

        uint l = clearingHouse.getAmmsLength();
        IAMM[] memory amms = new IAMM[](l);
        for (uint j = 0; j < l; j++) {
            amms[j] = clearingHouse.amms(j);
        }

        // loop over traders
        for (uint i; i < numTraders; i++) {
            (makerMargins[i], takerMargins[i]) = _calcMargin(traders[i], amms);
        }
    }

    function _calcMargin(address trader, IAMM[] memory amms)
        internal
        view
        returns(int makerMargin, int takerMargin)
    {
        // local vars
        IAMM amm;
        uint dToken;
        int margin;
        int unrealizedPnl;
        int takerFundingPayment;
        int makerFundingPayment;
        bool isMaker;
        bool isTaker;

        // loop over amms
        for (uint j = 0; j < amms.length; j++) {
            amm = amms[j];
            (takerFundingPayment,makerFundingPayment,,) = amm.getPendingFundingPayment(trader);

            // maker
            IAMM.Maker memory maker = amm.makers(trader);
            dToken = maker.dToken;
            if (dToken > 0) {
                isMaker = true;
                (,,unrealizedPnl) = hubbleViewer.getMakerPositionAndUnrealizedPnl(trader, j);
                makerMargin += (unrealizedPnl - makerFundingPayment);
            }

            // taker. using dToken to save a variable
            (dToken,unrealizedPnl) = amm.getTakerNotionalPositionAndUnrealizedPnl(trader);
            if (dToken > 0) {
                isTaker = true;
                takerMargin += (unrealizedPnl - takerFundingPayment);
            }
        }

        margin = marginAccount.getSpotCollateralValue(trader);
        if (isMaker) {
            makerMargin += margin;
        }
        if (isTaker) {
            takerMargin += margin;
        }
    }
}

