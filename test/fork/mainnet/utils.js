function getAMMVars(amm, trader) {
    return Promise.all([
        amm.vamm(),
        amm.underlyingAsset(),
        amm.name(),
        amm.fundingBufferPeriod(),
        amm.nextFundingTime(),
        amm.cumulativePremiumFraction(),
        amm.cumulativePremiumPerDtoken(),
        amm.posAccumulator(),
        amm.longOpenInterestNotional(),
        amm.shortOpenInterestNotional(),
        amm.maxOracleSpreadRatio(),
        amm.maxLiquidationRatio(),
        amm.maxLiquidationPriceSpread(),
        amm.positions(trader),
        amm.makers(maker), // has liquidity
        amm.withdrawPeriod(),
        amm.unbondPeriod(),
        amm.ignition(),
        amm.ammState(),
        amm.minSizeRequirement(),
    ])
}

function getCHVars(ch) {
    return Promise.all([
        ch.maintenanceMargin(),
        ch.tradeFee(),
        ch.liquidationPenalty(),
        ch.fixedMakerLiquidationFee(),
        ch.minAllowableMargin(),
        ch.referralShare(),
        ch.tradingFeeDiscount(),
        ch.vusd(),
        ch.marginAccount(),
        ch.amms(0),
        ch.hubbleReferral(),
    ])
}

function getVAMMVars(vamm) {
    const gasLimit = 1e6
    return Promise.all([
        vamm.totalSupply({ gasLimit }),
        vamm.price_scale({ gasLimit }),
        vamm.price_oracle({ gasLimit }),
        vamm.mark_price({ gasLimit }),
        vamm.last_prices({ gasLimit }),
        vamm.last_prices_timestamp({ gasLimit }),

        vamm.balances(0, { gasLimit }),
        vamm.balances(1, { gasLimit }),

        vamm.D({ gasLimit }),
        vamm.admin_actions_deadline({ gasLimit }), // last variable
    ])
}

function getMAVars(ma, trader) {
    return Promise.all([
        ma.clearingHouse(),
        ma.oracle(),
        ma.insuranceFund(),
        ma.vusd(),
        ma.credit(),
        ma.supportedAssets(),
        ma.liquidationIncentive(),
        ma.margin(0, trader)
    ])
}

module.exports = {
    config,
    getAMMVars,
    getCHVars,
    getMAVars,
    getVAMMVars
}
