# Hubble Exchange
Perpetual futures exchange on Avalanche.

### Foundry installation
Follow [this](https://book.getfoundry.sh/getting-started/installation) to intall foundry
#### Install libs
```
forge install foundry-rs/forge-std
```

### Compile
```
npm run vyper-compile && npm run compile
```

### Tests
#### HardHat tests
```
npm t
```
#### Foundry tests
```
forge test -vvv
forge test -vvv --watch // for watch mode
```

### Local Deployment
```
# starts node on `http://127.0.0.1:8545/` with 10K ETH in 20 accounts generated from mnemonic: "test test test test test test test test test test test junk"

npx hardhat node
npx hardhat run scripts/deploy-local.js --network local
```

### Fuji Deployment
```
npx hardhat run scripts/deploy-fuji.js --network fuji
```

### Documentation
```
npx hardhat docgen
```
Open `./docgen/index.html` in a browser.

### Coverage
```
npx hardhat coverage
```
Open `./coverage/index.html` in a browser.


### Gas Reporter
```
npm run gas-reporter
```
