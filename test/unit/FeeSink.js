const { expect } = require("chai")
const { BigNumber } = require("ethers")
const utils = require("../utils")
const {
    addMargin,
    constants,
    setupContracts,
    encodeLimitOrder
} = utils

const {
    _1e6,
    _1e12,
    _1e18,
    ZERO
} = constants


describe("FeeSink Unit Tests", function() {
    let treasuryAddress = "0x22Bb736b64A0b4D4081E103f83bccF864F0404aa"

    beforeEach(async function() {
        signers = await ethers.getSigners()
        ;({ orderBook, clearingHouse, feeSink, insuranceFund, marginAccount, oracle, vusd } = await setupContracts({ testClearingHouse: false, mockOrderBook: false, treasuryAddress }))
        governance = signers[0]
    })

    context("initialization", function() {
        it("initializes properly", async function() {
            actualFeeSinkInsuranceFundAddress = await feeSink.insuranceFund()
            expect(actualFeeSinkInsuranceFundAddress).to.equal(insuranceFund.address)
            actualFeeSinkTreasuryAddress = await feeSink.treasury()
            expect(actualFeeSinkTreasuryAddress).to.equal(treasuryAddress)
        })

        it("fails if we try to initialize again", async function() {
            newMaxFeePercentageForInsuranceFund = BigNumber.from(1000)
            newInsuranceFundToOpenInterestTargetRatio = BigNumber.from(1000)
            await expect(feeSink.initialize(governance.address, treasuryAddress)).to.be.revertedWith("Initializable: contract is already initialized")
        })
    })

    context("setters", function() {
        it("sets treasury address", async function() {
            newTreasury = signers[4]
            await feeSink.setTreasury(newTreasury.address)
            actualFeeSinkTreasuryAddress = await feeSink.treasury()
            expect(actualFeeSinkTreasuryAddress).to.equal(newTreasury.address)
        })

        it("sets maxFeePercentageForInsuranceFund", async function() {
            newMaxFeePercentageForInsuranceFund = BigNumber.from(1000)
            await feeSink.setMaxFeePercentageForInsuranceFund(newMaxFeePercentageForInsuranceFund)
            actualMaxFeePercentageForInsuranceFund = await feeSink.maxFeePercentageForInsuranceFund()
            expect(actualMaxFeePercentageForInsuranceFund).to.equal(newMaxFeePercentageForInsuranceFund)
        })

        it("sets insuranceFundToOpenInterestTargetRatio", async function() {
            newInsuranceFundToOpenInterestTargetRatio = BigNumber.from(1000)
            await feeSink.setInsuranceFundToOpenInterestTargetRatio(newInsuranceFundToOpenInterestTargetRatio)
            actualInsuranceFundToOpenInterestTargetRatio = await feeSink.insuranceFundToOpenInterestTargetRatio()
            expect(actualInsuranceFundToOpenInterestTargetRatio).to.equal(newInsuranceFundToOpenInterestTargetRatio)
        })
    })

    context("distributeFunds", function() {
        context("when it is called by a non-governance address or address is not present in validFundsDistributors", function() {
            it("reverts", async function() {
                await expect(feeSink.connect(signers[1]).distributeFunds()).to.be.revertedWith("FeeSink: not allowed execute distributeFunds")
            })
        })

        context("when it is called by a governance address or address is present in validFundsDistributors", function() {
            beforeEach(async function() {
                validAccount = await getGovernanceOrValidFundsDistributorAccount()
            })

            context("when feeSink's vusd balance is not zero", function() {
                let feeSinkBalance = BigNumber.from(500).mul(_1e12)
                bootstrapFeeSinkBalance = feeSinkBalance

                beforeEach(async function() {
                    await vusd.mint(feeSink.address, feeSinkBalance)
                })

                context("when atleast one of maxFeePercentageForInsuranceFund insuranceFundToOpenInterestTargetRatio is zero", function() {
                    context("when maxFeePercentageForInsuranceFund and insuranceFundToOpenInterestTargetRatio are both zero", function() {
                        it("sends all money to the treasury", async function() {
                            let maxFeePercentageForInsuranceFund = BigNumber.from(0)
                            let insuranceFundToOpenInterestTargetRatio = BigNumber.from(0)
                            await feeSink.setMaxFeePercentageForInsuranceFund(maxFeePercentageForInsuranceFund)
                            await feeSink.setInsuranceFundToOpenInterestTargetRatio(insuranceFundToOpenInterestTargetRatio)

                            initialTreasuryBalance = await vusd.balanceOf(treasuryAddress)
                            initialInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)

                            await feeSink.connect(await getGovernanceOrValidFundsDistributorAccount()).distributeFunds()

                            treasuryBalance = await vusd.balanceOf(treasuryAddress)
                            expect(treasuryBalance).to.equal(initialTreasuryBalance.add(feeSinkBalance))
                            actualInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)
                            expect(actualInsuranceFundBalance).to.equal(initialInsuranceFundBalance)
                        })
                    })
                    context("when maxFeePercentageForInsuranceFund is zero and insuranceFundToOpenInterestTargetRatio is not zero", function() {
                        it("sends all money to the treasury", async function() {
                            let maxFeePercentageForInsuranceFund = BigNumber.from(0)
                            let insuranceFundToOpenInterestTargetRatio = BigNumber.from(1e5) // 10%
                            await feeSink.setMaxFeePercentageForInsuranceFund(maxFeePercentageForInsuranceFund)
                            await feeSink.setInsuranceFundToOpenInterestTargetRatio(insuranceFundToOpenInterestTargetRatio)

                            initialTreasuryBalance = await vusd.balanceOf(treasuryAddress)
                            initialInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)

                            await feeSink.connect(await getGovernanceOrValidFundsDistributorAccount()).distributeFunds()

                            treasuryBalance = await vusd.balanceOf(treasuryAddress)
                            expect(treasuryBalance).to.equal(initialTreasuryBalance.add(feeSinkBalance))
                            actualInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)
                            expect(actualInsuranceFundBalance).to.equal(initialInsuranceFundBalance)
                        })
                    })
                    context("when maxFeePercentageForInsuranceFund is not zero and insuranceFundToOpenInterestTargetRatio is zero", function() {
                        it("sends all money to the treasury", async function() {
                            let maxFeePercentageForInsuranceFund = BigNumber.from(1e5) // 10%
                            let insuranceFundToOpenInterestTargetRatio = BigNumber.from(0)
                            await feeSink.setMaxFeePercentageForInsuranceFund(maxFeePercentageForInsuranceFund)
                            await feeSink.setInsuranceFundToOpenInterestTargetRatio(insuranceFundToOpenInterestTargetRatio)

                            initialTreasuryBalance = await vusd.balanceOf(treasuryAddress)
                            initialInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)

                            await feeSink.connect(await getGovernanceOrValidFundsDistributorAccount()).distributeFunds()

                            treasuryBalance = await vusd.balanceOf(treasuryAddress)
                            expect(treasuryBalance).to.equal(initialTreasuryBalance.add(feeSinkBalance))
                            actualInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)
                            expect(actualInsuranceFundBalance).to.equal(initialInsuranceFundBalance)
                        })
                    })
                })

                context("when maxFeePercentageForInsuranceFund and insuranceFundToOpenInterestTargetRatio are both not zero", function() {
                    let maxFeePercentageForInsuranceFund = BigNumber.from(100000) // 10%
                    let insuranceFundToOpenInterestTargetRatio = BigNumber.from(400000) // 40%

                    beforeEach(async function() {
                        await feeSink.setMaxFeePercentageForInsuranceFund(maxFeePercentageForInsuranceFund)
                        await feeSink.setInsuranceFundToOpenInterestTargetRatio(insuranceFundToOpenInterestTargetRatio)
                    })

                    context("when open interest is zero", function() {
                        it("sends all money to the treasury", async function() {
                            initialTreasuryBalance = await vusd.balanceOf(treasuryAddress)
                            initialInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)

                            await feeSink.connect(await getGovernanceOrValidFundsDistributorAccount()).distributeFunds()

                            treasuryBalance = await vusd.balanceOf(treasuryAddress)
                            expect(treasuryBalance).to.equal(initialTreasuryBalance.add(feeSinkBalance))
                            actualInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)
                            expect(actualInsuranceFundBalance).to.equal(initialInsuranceFundBalance)
                        })
                    })
                    context("when open interest is not zero", function() {
                        context("when insuranceFundBalance/openInterest > insuranceFundToOpenInterestTargetRatio", function() {
                            it("sends all money to the treasury", async function() {
                                let response = await setupOpenInterest()
                                openInterestInVusd = response.openInterestInVusd
                                totalPlaceOrderFee = response.totalFee

                                await vusd.mint(insuranceFund.address, openInterestInVusd.add(BigNumber.from(1)))

                                initialTreasuryBalance = await vusd.balanceOf(treasuryAddress)
                                initialInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)

                                await feeSink.connect(await getGovernanceOrValidFundsDistributorAccount()).distributeFunds()

                                treasuryBalance = await vusd.balanceOf(treasuryAddress)
                                expectedTreasuryBalance = initialTreasuryBalance.add(feeSinkBalance).add(totalPlaceOrderFee)
                                expect(treasuryBalance.toString()).to.equal(expectedTreasuryBalance.toString())
                                actualInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)
                                expect(actualInsuranceFundBalance.toString()).to.equal(initialInsuranceFundBalance.toString())
                            })
                        })
                        context("when insuranceFundBalance/openInterest = insuranceFundToOpenInterestTargetRatio", function() {
                            it("sends all money to the treasury", async function() {
                                let response = await setupOpenInterest()
                                openInterestInVusd = response.openInterestInVusd
                                totalPlaceOrderFee = response.totalFee

                                insuranceFundBalance = openInterestInVusd.mul(insuranceFundToOpenInterestTargetRatio).div(_1e6)
                                await vusd.mint(insuranceFund.address, openInterestInVusd)

                                initialTreasuryBalance = await vusd.balanceOf(treasuryAddress)
                                initialInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)

                                await feeSink.connect(await getGovernanceOrValidFundsDistributorAccount()).distributeFunds()

                                treasuryBalance = await vusd.balanceOf(treasuryAddress)
                                expectedTreasuryBalance = initialTreasuryBalance.add(feeSinkBalance).add(totalPlaceOrderFee)
                                expect(treasuryBalance.toString()).to.equal(expectedTreasuryBalance.toString())
                                actualInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)
                                expect(actualInsuranceFundBalance.toString()).to.equal(initialInsuranceFundBalance.toString())
                            })
                        })
                        context("when insuranceFundBalance/openInterest < insuranceFundToOpenInterestTargetRatio", function() {
                            context("when insuranceFundBalance is zero", async function() {
                                it("distributed funds correctly", async function() {
                                    let response = await setupOpenInterest()
                                    openInterestInVusd = response.openInterestInVusd
                                    totalPlaceOrderFee = response.totalFee

                                    insuranceFundBalance = BigNumber.from(0)
                                    initialTreasuryBalance = await vusd.balanceOf(treasuryAddress)
                                    initialInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)
                                    expect(initialInsuranceFundBalance.toString()).to.equal("0")

                                    await feeSink.connect(await getGovernanceOrValidFundsDistributorAccount()).distributeFunds()

                                    const revenue = bootstrapFeeSinkBalance.add(totalPlaceOrderFee)
                                    expectedInsuranceFundBalance = revenue.mul(maxFeePercentageForInsuranceFund).div(_1e6)
                                    actualInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)
                                    expect(actualInsuranceFundBalance).to.equal(expectedInsuranceFundBalance)

                                    expectedTreasuryBalance = revenue.sub(expectedInsuranceFundBalance)
                                    actualTreasuryBalance = await vusd.balanceOf(treasuryAddress)
                                    expect(actualTreasuryBalance).to.equal(expectedTreasuryBalance)
                                })
                            })
                            context("when insuranceFundBalance is not zero", function() {
                                it("distributed funds correctly", async function() {
                                    let response = await setupOpenInterest()
                                    let openInterestInVusd = response.openInterestInVusd
                                    let totalPlaceOrderFee = response.totalFee

                                    let insuranceFundToOpenInterestRatio = insuranceFundToOpenInterestTargetRatio.div(2)
                                    insuranceFundInitialBalance = openInterestInVusd.mul(insuranceFundToOpenInterestRatio).div(_1e6)
                                    await vusd.mint(insuranceFund.address, insuranceFundInitialBalance)
                                    initialTreasuryBalance = await vusd.balanceOf(treasuryAddress)

                                    await feeSink.connect(await getGovernanceOrValidFundsDistributorAccount()).distributeFunds()

                                    totalFee = bootstrapFeeSinkBalance.add(totalPlaceOrderFee) // 500e12 + 5e6
                                    // insuranceFundFee = totalFee * 0.1 * ((0.2 - 0.1)/0.2) = (500e12 + 5e6) * 0.1 * 0.5 = 25000000250000
                                    insuranceFundFee = totalFee.mul(maxFeePercentageForInsuranceFund).mul(insuranceFundToOpenInterestTargetRatio.sub(insuranceFundToOpenInterestRatio)).div(insuranceFundToOpenInterestTargetRatio).div(_1e6)
                                    expectedInsuranceFundBalance = insuranceFundInitialBalance.add(insuranceFundFee)
                                    // treasuryFee = (500e12 + 5e6) - 25000000250000 = 475000004750000
                                    expectedTreasuryBalance = initialTreasuryBalance.add(totalFee).sub(expectedInsuranceFundBalance).add(insuranceFundInitialBalance)

                                    actualInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)
                                    expect(actualInsuranceFundBalance.toString()).to.equal(expectedInsuranceFundBalance.toString())

                                    actualTreasuryBalance = await vusd.balanceOf(treasuryAddress)
                                    expect(actualTreasuryBalance.toString()).to.equal(expectedTreasuryBalance.toString())
                                })

                                it("distributed funds correctly", async function() {
                                    let response = await setupOpenInterest()
                                    let openInterestInVusd = response.openInterestInVusd
                                    let totalPlaceOrderFee = response.totalFee

                                    let insuranceFundToOpenInterestRatio = insuranceFundToOpenInterestTargetRatio.div(4)
                                    insuranceFundInitialBalance = openInterestInVusd.mul(insuranceFundToOpenInterestRatio).div(_1e6)
                                    await vusd.mint(insuranceFund.address, insuranceFundInitialBalance)
                                    initialTreasuryBalance = await vusd.balanceOf(treasuryAddress)

                                    await feeSink.connect(await getGovernanceOrValidFundsDistributorAccount()).distributeFunds()

                                    totalFee = bootstrapFeeSinkBalance.add(totalPlaceOrderFee) // 500e12 + 5e6
                                    // insuranceFundFee = totalFee * 0.1 * ((0.4 - 0.1)/0.4) = (500e12 + 5e6) * 0.1 * 0.75 = 37500000375000
                                    insuranceFundFee = totalFee.mul(maxFeePercentageForInsuranceFund).mul(insuranceFundToOpenInterestTargetRatio.sub(insuranceFundToOpenInterestRatio)).div(insuranceFundToOpenInterestTargetRatio).div(_1e6)
                                    expectedInsuranceFundBalance = insuranceFundInitialBalance.add(insuranceFundFee)
                                    // treasuryFee = (500e12 + 5e6) - 37500000375000 = 462500004625000
                                    expectedTreasuryBalance = initialTreasuryBalance.add(totalFee).sub(expectedInsuranceFundBalance).add(insuranceFundInitialBalance)

                                    actualInsuranceFundBalance = await vusd.balanceOf(insuranceFund.address)
                                    expect(actualInsuranceFundBalance.toString()).to.equal(expectedInsuranceFundBalance.toString())

                                    actualTreasuryBalance = await vusd.balanceOf(treasuryAddress)
                                    expect(actualTreasuryBalance.toString()).to.equal(expectedTreasuryBalance.toString())
                                })
                            })
                        })
                    })
                })
            })
        })
    })
})


async function getGovernanceOrValidFundsDistributorAccount() {
    randomNumber = Math.floor(Math.random() * 100);
    if (randomNumber % 2 == 0) {
        return governance
    }
    return getValidFundsDistributorAccount()
}

async function getValidFundsDistributorAccount() {
    validAccount = signers[5]
    await feeSink.setValidFundsDistributors(validAccount.address, true)
    return validAccount
}


async function setupOpenInterest() {
        ;([, alice, bob, charlie] = signers)
        await addMargin(alice, _1e6.mul(4000))
        await addMargin(bob, _1e6.mul(4000))

        shortOrder = {
            ammIndex: ZERO,
            trader: alice.address,
            baseAssetQuantity: ethers.utils.parseEther('-5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now()),
            reduceOnly: false
        }
        await orderBook.connect(alice).placeOrder(shortOrder)
        order1Hash = await orderBook.getOrderHash(shortOrder)
       // long order with same price and baseAssetQuantity
        longOrder = {
            ammIndex: ZERO,
            trader: bob.address,
            baseAssetQuantity: ethers.utils.parseEther('5'),
            price: ethers.utils.parseUnits('1000', 6),
            salt: BigNumber.from(Date.now()),
            reduceOnly: false
        }
        await orderBook.connect(bob).placeOrder(longOrder)
        order2Hash = await orderBook.getOrderHash(longOrder)

        await orderBook.setValidatorStatus(charlie.address, true)
        const matchArgs = [encodeLimitOrder(longOrder), encodeLimitOrder(shortOrder)]
        const tx = await orderBook.connect(charlie).executeMatchedOrders(matchArgs, longOrder.baseAssetQuantity)
        shortOrderTradeFee = shortOrder.baseAssetQuantity.mul(shortOrder.price).div(_1e18).mul(500).div(_1e6).abs()
        longOrderTradeFee = longOrder.baseAssetQuantity.mul(longOrder.price).div(_1e18).mul(500).div(_1e6).abs()
        openInterestInVusd = (longOrder.baseAssetQuantity.add(shortOrder.baseAssetQuantity.abs())).mul(longOrder.price).div(_1e18)
        totalFee = shortOrderTradeFee.add(longOrderTradeFee)
        return {
            openInterestInVusd: openInterestInVusd,
            totalFee: totalFee
        }
}
