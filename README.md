# Perpetuals | Optimism

Vyper compilation with hardhat takes a ton of time and is performed on every run (no caching). Therefore, we place .vy files outside the contracts directory and manually compile and dump the abi and bytecode in files that are then picked up in the tests.

One-Time vyper setup
```
python3 -m venv venv
source venv/bin/activate
pip install vyper==0.2.12
```

```
vyper -f abi,bytecode vyper/Swap.vy > vyper/Swap.txt
vyper -f abi,bytecode vyper/MoonMath.vy > vyper/MoonMath.txt
vyper -f abi,bytecode vyper/Views.vy > vyper/Views.txt
```

```
npm t
```
