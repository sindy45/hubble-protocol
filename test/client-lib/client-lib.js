const { expect } = require('chai')
const { getVammJS } = require('../../dist/VammJS')

const {
    constants: { _1e6, _1e18 },
    setupContracts,
    setupRestrictedTestToken,
    setupAmm,
    addMargin,
    bnToFloat
} = require('../utils')

const gasLimit = 1e6
const ACCURACY = 10**-1

describe('vammJS and vamm parity', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        governance = signers[0].address
        trader = signers[1]
        maker2 = signers[10]

        await setupContracts({ governance, setupAMM: false })

        const avax = await setupRestrictedTestToken('Avalanche', 'AVAX', 8)

        // 3. AMMs
        const liquidityTarget = 5e6
        initialRate = 109.8 // avax rate on Jan 1
        const ammOptions = {
            initialRate,
            initialLiquidity: liquidityTarget / (2 * initialRate),
            fee: 5000000, // .05%
            ammState: 2 // Active
        }
        ;({ amm, vamm } = await setupAmm(
            governance,
            [ 'AVAX-PERP', avax.address, oracle.address, 0 ],
            Object.assign(ammOptions, { index: 0 })
        ))

        // maker2 adds liq
        const makerLiqTarget = 10000
        await addMargin(maker2, _1e6.mul(makerLiqTarget))
        clearingHouse.connect(maker2).addLiquidity(0, ethers.utils.parseUnits((makerLiqTarget / (2 * initialRate)).toString(), 18), 0)

        // trader adds margin
        const initialVusdAmount = _1e6.mul(_1e6).mul(10) // $10m
        await addMargin(trader, initialVusdAmount)

        vammJS = await getVammJS(vamm)
    })

    it('state vars match after many trades', async function() {
        for (let i = 1; i <= 10; i++) {
            const size = i * 3
            if (i % 2) { // long
                const _size = ethers.utils.parseUnits(size.toString(), 18)
                expect(
                    vammJS.get_dx(size)[0]
                ).to.be.approximately(
                    bnToFloat(await vamm.get_dx(0, 1, _size, { gasLimit }), 6),
                    ACCURACY
                )
                vammJS.long(size, (size + 1) * initialRate)
                await clearingHouse.connect(trader).openPosition(0, _size, _1e18)
            } else { // short
                expect(
                    vammJS.get_dy(size)[0]
                ).to.be.approximately(
                    bnToFloat(await vamm.get_dy(1, 0,  ethers.utils.parseUnits(size.toString(), 18), { gasLimit }), 6),
                    ACCURACY
                )
                vammJS.short(size, (size - 1) * initialRate)
                await clearingHouse.connect(trader).openPosition(0, ethers.utils.parseUnits((-size).toString(), 18), 0)
            }
            await assertions(vamm, vammJS)
        }
    })
})

async function assertions(vamm, vammJS) {
    let vammJsVars = vammJS.vars()
    let vars = await vamm.vars({ gasLimit })

    // console.log('vammJS after exchange', vammJsVars)
    expect(vammJsVars.balances[0]).to.be.approximately(bnToFloat(vars[0][0], 6), ACCURACY)
    expect(vammJsVars.balances[0]).to.be.approximately(bnToFloat(vars[0][0], 6), ACCURACY)
    expect(vammJsVars.price_scale).to.be.approximately(bnToFloat(vars[1], 18), ACCURACY)
    expect(vammJsVars.price_oracle).to.be.approximately(bnToFloat(vars[2], 18), ACCURACY)
    expect(vammJsVars.last_prices).to.be.approximately(bnToFloat(vars[3], 18), ACCURACY)
    expect(vammJsVars.ma_half_time).to.eq(parseFloat(vars[4]))
    expect(vammJsVars.totalSupply).to.be.approximately(bnToFloat(vars[5], 18), ACCURACY)
    expect(vammJsVars.xcp_profit).to.be.approximately(bnToFloat(vars[6], 18), ACCURACY)
    expect(vammJsVars.virtual_price).to.be.approximately(bnToFloat(vars[7], 18), ACCURACY)
    expect(vammJsVars.adjustment_step).to.be.approximately(bnToFloat(vars[8], 18), ACCURACY)
    expect(vammJsVars.allowed_extra_profit).to.be.approximately(bnToFloat(vars[9], 18), ACCURACY)
    expect(vammJsVars.not_adjusted).to.eq(vars[10])
    expect(vammJsVars.D).to.be.approximately(bnToFloat(vars[11], 18), ACCURACY)

    const smol = 0.00001
    const new_mp_dx = bnToFloat(await vamm.get_dx(0, 1, ethers.utils.parseUnits(smol.toString()), { gasLimit })) / smol
    const new_mp_dy = bnToFloat(await vamm.get_dy(1, 0, ethers.utils.parseUnits(smol.toString()), { gasLimit })) / smol
    const mp = vammJS.markPrice()
    expect(mp).to.be.approximately(new_mp_dx, ACCURACY)
    expect(mp).to.be.approximately(new_mp_dy, ACCURACY)
    // console.log({ mp })

    let { position, openNotional, unrealizedPnl } = await hubbleViewer.getMakerPositionAndUnrealizedPnl(maker2.address, 0)
    let _maker2 = await amm.makers(maker2.address)
    vammJsVars = vammJS.get_maker_position(
        bnToFloat(_maker2.dToken, 18),
        bnToFloat(_maker2.vUSD, 6),
        bnToFloat(_maker2.vAsset, 18),
        bnToFloat(_maker2.dToken, 18),
    )
    expect(vammJsVars.position).to.be.approximately(bnToFloat(position, 18), ACCURACY)
    expect(vammJsVars.openNotional).to.be.approximately(bnToFloat(openNotional), ACCURACY)
    expect(vammJsVars.unrealizedPnl).to.be.approximately(bnToFloat(unrealizedPnl), ACCURACY)
}
