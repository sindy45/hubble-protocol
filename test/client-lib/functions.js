const { expect } = require('chai')
const { get_dy, get_dx, get_D } = require('../../dist/VammJS')

const ACCURACY = 2 * 10**-6

describe('get dy', () => {
    // Mocha
    it('asset quantity = 5', () => {
        const baseAssetQuantity =  5
        const balances =  [ 1000000, 1000 ]
        const D =  2000000
        const priceScale =  1000
        const A =  400000
        const gamma = 0.000145
        const midFee =  0.001
        const [dy, dyFee] = get_dy(1, 0, baseAssetQuantity, balances, D, priceScale, A, gamma, midFee)

        // values from the contract = dy = 4993422336, dy_fee = 4998420
        expect(dy).to.be.approximately(4993.422336, ACCURACY)
        expect(dyFee).to.be.approximately(4.998420, ACCURACY)
    })

    it('asset quantity = 10', () => {
        const baseAssetQuantity =  10
        const balances =  [ 1000000, 1000 ]
        const D =  2000000
        const priceScale =  1000
        const A =  400000
        const gamma =  0.000145
        const midFee =  0.001
        const [dy, dyFee] = get_dy(1, 0, baseAssetQuantity, balances, D, priceScale, A, gamma, midFee)

        // values from the contract = dy = 9978552295, dy_fee = 9988540
        expect(dy).to.be.approximately(9978.552295, ACCURACY)
        expect(dyFee).to.be.approximately(9.988540, ACCURACY)
    })

    it('asset quantity = 20', () => {
        const baseAssetQuantity =  20
        const balances =  [ 1000000, 1000 ]
        const D =  2000000
        const priceScale =  1000
        const A =  400000
        const gamma =  0.000145
        const midFee =  0.001
        const [dy, dyFee] = get_dy(1, 0, baseAssetQuantity, balances, D, priceScale, A, gamma, midFee)

        // values from the contract = dy = 19861149896, dy_fee = 19881030
        expect(dy).to.be.approximately(19861.149896, ACCURACY)
        expect(dyFee).to.be.approximately(19.881030, ACCURACY)
    })

    it('real values for params', () => {
        const baseAssetQuantity =  5

        // these values were taken from testnet at block 7146232
        const balances =  [ 12245740.03391, 174518.5312185505 ]
        const D =  25765458.099948386397270708
        const priceScale =  77.596059480153932506
        const A =  400000
        const gamma =  0.000145
        const midFee =  0.0005000000
        const [dy, dyFee] = get_dy(1, 0, baseAssetQuantity, balances, D, priceScale, A, gamma, midFee)

        // values from the contract => dy =  355.901134, dy_fee =  0.178039
        expect(dy).to.be.approximately(355.901134, ACCURACY)
        expect(dyFee).to.be.approximately(0.178039, ACCURACY)
    })
})

describe('get dx', () => {
    // Mocha
    it('asset quantity = 5', () => {
        const baseAssetQuantity =  5
        const balances =  [ 1000000, 1000 ]
        const D =  2000000
        const priceScale =  1000
        const A =  400000
        const gamma =  0.000145
        const midFee =  0.001
        const [dx, dxFee] = get_dx(0, 1, baseAssetQuantity, balances, D, priceScale, A, gamma, midFee)

        // values from the contract = dx = 5006582077, dx_fee = 5001580
        expect(dx).to.be.approximately(5006.582077, ACCURACY)
        expect(dxFee).to.be.approximately(5.001580, ACCURACY)
    })

    it('asset quantity = 10', () => {
        const baseAssetQuantity =  10
        const balances =  [ 1000000, 1000 ]
        const D =  2000000
        const priceScale =  1000
        const A =  400000
        const gamma =  0.000145
        const midFee =  0.001
        const [dx, dxFee] = get_dx(0, 1, baseAssetQuantity, balances, D, priceScale, A, gamma, midFee)

        // values from the contract = dx = 10021513301, dx_fee = 10011501
        expect(dx).to.be.approximately(10021.513301, ACCURACY)
        expect(dxFee).to.be.approximately(10.011501, ACCURACY)
    })

    it('asset quantity = 20', () => {
        const balances =  [ 1000000, 1000 ]
        const baseAssetQuantity =  20
        const D =  2000000
        const priceScale =  1000
        const A =  400000
        const gamma =  0.000145
        const midFee =  0.001
        const [dx, dxFee] = get_dx(0, 1, baseAssetQuantity, balances, D, priceScale, A, gamma, midFee)

        // values from the contract = dx = 20141487978, dx_fee = 20121366
        expect(dx).to.be.approximately(20141.487978, ACCURACY)
        expect(dxFee).to.be.approximately(20.121366, ACCURACY)
    })

    it('real values for params', () => {
        const baseAssetQuantity =  12

        // these values were taken from testnet at block 7146232
        const balances =  [ 12245740.03391, 174518.5312185505 ]
        const D =  25765458.099948386397270708
        const priceScale =  77.596059480153932506
        const A =  400000
        const gamma =  0.000145
        const midFee =  0.0005000000
        const [dx, dxFee] = get_dx(0, 1, baseAssetQuantity, balances, D, priceScale, A, gamma, midFee)

        // values from the contract => dx =  855.106375, dx_fee =  0.427339
        expect(dx).to.be.approximately(855.106375, ACCURACY)
        expect(dxFee).to.be.approximately(0.427339, ACCURACY)
    })
})

describe('short of 2000 at 7146332', () => {
    it('get_D', () => {
        // these values were taken from testnet at block 7146332
        const balances =  [ 11481525.631091, 185999.681468830244442125 ]
        const D = 25669978.245373281449984163
        const priceScale =  77.020014440277296751 // at previous block
        const A =  400000
        const gamma =  0.000145

        expect(get_D(A, gamma, balances, priceScale)).to.be.approximately(D, ACCURACY)
    })

    it('get_dy/markPrice', () => {
        // these values were taken from testnet at block 7146331
        const balances =  [ 11607655.295472, 183999.681468830244442125 ]
        const D = 25669908.093148422898881731
        const priceScale =  77.020014440277296751
        const A =  400000
        const gamma =  0.000145
        const midFee =  0.0005000000
        const baseAsset = 2000

        // lastPrice of the trade
        const lastPrice = 63.06483219
        // price for a short/long of 1e-4 on testnet at 7146332 = 62.4
        const intstantaneousPrice = 62.4
        const dy = get_dy(1, 0, baseAsset, balances, D, priceScale, A, gamma, midFee)
        expect(dy[0]/baseAsset).to.be.approximately(lastPrice, ACCURACY)
        expect(dy[2]).to.be.approximately(intstantaneousPrice, 0.3) // 62.6294334705407
    })

    it('get_dx/markPrice', () => {
        // long of 10 at block 7146333 on testnet
        // these values were taken from testnet one block before i.e. 7146332
        const balances =  [ 11481525.631091, 185999.681468830244442125 ]
        const D = 25669978.245373281449984163
        const priceScale =  77.020014440277296751
        const A =  400000
        const gamma =  0.000145
        const midFee =  0.0005000000
        const baseAsset = 10

        // lastPrice of the trade
        const lastPrice = 62.4359439
        // price for a long of 1e-4 on testnet at 7146333 = 62.4
        const intstantaneousPrice = 62.4
        const dx = get_dx(0, 1, baseAsset, balances, D, priceScale, A, gamma, midFee)
        expect(dx[0]/baseAsset).to.be.approximately(lastPrice, ACCURACY)
        expect(dx[2]).to.be.approximately(intstantaneousPrice, 0.3) // 62.63637008732404
    })
})
