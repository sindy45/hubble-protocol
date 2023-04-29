const utils = require('../../test/utils')

const {
    constants: { _1e6, _1e18 },
    sleep
} = utils

async function mintNative() {
    const nativeMinter = await ethers.getContractAt('INativeMinter', '0x0200000000000000000000000000000000000001')

    const maker = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    await nativeMinter.mintNativeCoin(maker, _1e18.mul(39999))

    const taker = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
    await nativeMinter.mintNativeCoin(taker, _1e18.mul(40000))
}

async function depositMargin() {
    ;([, alice, bob] = await ethers.getSigners())
    const maHelper = await ethers.getContractAt('MarginAccountHelper', '0xD14c5E83936012FE510bc66252eF9F7F84F87E8e')

    const amount = _1e6.mul(35000)
    // await maHelper.connect(alice).addVUSDMarginWithReserve(amount, { value: _1e18.mul(35000) })
    await maHelper.connect(bob).addVUSDMarginWithReserve(amount, { value: _1e18.mul(35000) })

    const marginAccount = await ethers.getContractAt('MarginAccount', '0x0300000000000000000000000000000000000070')
    console.log(await marginAccount.margin(0, alice.address))
    console.log(await marginAccount.margin(0, bob.address))
}

async function userPositions() {
    ;([, alice, bob] = await ethers.getSigners())
    const hubbleViewer = await ethers.getContractAt('HubbleViewer', '0x5F1f4Eb04a82b4D78D99b6eFd412e0B69653E75b')
    console.log(await hubbleViewer.userPositions(alice.address))
    console.log(await hubbleViewer.userPositions(bob.address))
}

userPositions()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
