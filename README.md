# Hubble Exchange
Perpetual futures exchange on Avalanche.

### One-Time vyper setup
Vyper compilation with hardhat takes a ton of time and is performed on every run (no caching). Therefore, we place .vy files outside the contracts directory and manually compile and dump the abi and bytecode in files that are then picked up in the tests.

```
python3 -m venv venv
source venv/bin/activate
pip install vyper==0.2.12
npm run vyper-compile
```

### Compile
```
npm run compile
```

### Tests
```
npm t
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
