/**
 *
 * @param amount amount to add scaled to 1e6
 * @dev assumes trader has gas token >= amount * 1e12
 */
async function addVUSDWithReserve(trader, amount, gasLimit = 5e6) {
    const _txOptions = {}
    _txOptions.gasLimit = gasLimit
    _txOptions.value = amount.mul(1e12)
    await vusd.connect(trader).mintWithReserve(trader.address, amount, _txOptions)
}

/**
 *
 * @param margin husd margin to add scaled to 1e6
 * @dev assumes trader has gas token >= amount * 1e12
 */
async function addMargin(trader, margin, gasLimit = 5e6) {
    const _txOptions = {}
    _txOptions.gasLimit = gasLimit
    _txOptions.value = margin.mul(1e12)
    await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin, _txOptions)
}

module.exports = {
    addVUSDWithReserve,
    addMargin
}
