# Pinned ERC-8004 reference sources

These two Solidity files are unmodified copies from the public
[`erc-8004/erc-8004-contracts`](https://github.com/erc-8004/erc-8004-contracts)
repository at commit `b9e466c250744a7e06b13dff9d3c2844ed64f825`:

- `HardhatMinimalUUPS.sol` — SHA-256
  `9d3b152b88733e61f40ae2de775f7448001b73d9165f23ee8bbe5dd88cd042aa`
- `IdentityRegistryUpgradeable.sol` — SHA-256
  `18c8ca8c88493b46e54d000c96eaf7470d1f9dbfe55493fd7fa923bae543ff75`

Each source retains its upstream MIT SPDX notice. The local compiler rejects a
hash mismatch before compiling. It also compiles OpenZeppelin's
`ERC1967Proxy.sol` from the exact `@openzeppelin/contracts@5.4.0` package; that
entry source has SHA-256
`a06fe97082355529c1da9076ea6c4518875ca9fdb1a4fa1e194c35cff21b29a1`.

The compiler is pinned to solc-js 0.8.24 with Shanghai EVM output, optimizer
enabled at 200 runs, and `viaIR: true`. These sources and the proxy bootstrap are
local demonstration machinery. They are not a replacement registry and are not
a deployment recommendation.

The npm override for solc's legacy `tmp` dependency is deliberately limited to
patched `tmp@0.2.7`. It preserves solc 0.8.24 and the `fileSync` API that solc's
optional SMT-solver adapter uses. Clean-install audit and the artifact hashes
below guard the dependency and compiler-output assumptions.

The compiler also checks these SHA-256 hashes over each emitted ABI, creation
bytecode, and deployed bytecode tuple:

- `IdentityRegistryUpgradeable`:
  `c0e4f95ece5aef9020e27463e849a96ebcf802f252d8d5fc72f7dbe3ec1739c2`
- `HardhatMinimalUUPS`:
  `6d7c978d16accfd97118f9f715dbee54cd04ed23a1fde5131a62d434e2a0220f`
- `ERC1967Proxy`:
  `5271c17a982ad7edc3441b1e6d8d69c723e5ffc96f1cd0ff99f04e743bc5c381`
