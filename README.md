# NANDA City

NANDA City currently provides an identity/profile foundation and a real local
ERC-8004 Identity Registry demonstration for a future city-specialist agent
experience. It does **not** provide discovery, public-chain deployment, service
invocation, receipts, reputation, a user interface, or a deployed service.

The companion [NANDA Index fork](https://github.com/JamesCarnley/nanda-index-v2#structured-service-discovery)
provides exact per-service capability, service-area and interface filtering,
organization-admin publishing, and source-qualified results. It is useful without
Ethereum or reputation. Connecting these Index projections to City's ERC-8004
profiles across two independently persisted Index instances is the next
integration step; that connection is not implemented yet.

The codec validates an embedded ERC-8004 registration-v1 document, City's
namespaced profile fields, and the selected minimal A2A 0.3 AgentCard shape. The
pure verifier binds those exact bytes to a caller-supplied authority snapshot.
The local adapter can obtain that snapshot from one block-qualified RPC basis;
it does not fetch an AgentCard URL.

## Requirements

- Node.js 24 or newer
- npm
- Anvil 1.7.1 from Foundry, on `PATH`, for integration checks and the demo

The local process workflow is verified on macOS and in
[Linux CI](https://github.com/JamesCarnley/NandaCity/actions/runs/35251688937),
including the actual-Anvil integration tests. Install the pinned Foundry release
with:

```sh
foundryup --install v1.7.1
```

No paid account, hosted RPC, wallet, API key, or environment secret is needed.

## Setup and checks

```sh
npm ci
npm test
npm run test:integration
npm run contracts:check
npm run demo:identity
npm run --silent demo:identity -- --json
npm run typecheck
npm run build
npm run check
```

`npm test` is the fast unit suite. `npm run test:integration` is the explicit
real-chain suite and fails with setup guidance if Anvil is unavailable; it never
silently skips. `npm run check` deliberately runs typechecking, unit tests, the
production build, and that integration suite. Generated TypeScript files are
written to `dist/` and are not committed.

`npm run demo:identity` prints a plain summary. Add `--json` as shown above for
machine-readable output; `--silent` suppresses npm's lifecycle banner so stdout
is JSON only. A failed acceptance assertion exits nonzero.

## What the local demonstration does

The command compiles the pinned upstream sources, starts its own Anvil process
on an available loopback port with chain ID 31337, and generates temporary demo
keys in the Node process. It starts Anvil with zero built-in accounts and funds
only the generated addresses through the local test RPC. It never reads a
machine wallet or environment secret, never targets a non-loopback write RPC,
and stops only the child process it created.

Each launch supplies a randomized genesis block number and timestamp. Before the
demo callback can fund an address or write a transaction, readiness checks the
RPC chain ID and both marker fields and confirms the spawned child is still
alive. If another process wins the brief port-allocation race, its RPC cannot be
accepted as the owned chain and is not mutated or stopped.

The deployment follows the upstream upgrade test rather than imitating the
registry:

1. Deploy upstream `HardhatMinimalUUPS`.
2. Deploy OpenZeppelin `ERC1967Proxy` initialized against that minimal
   implementation, establishing initializer version 1 and the registry admin.
3. Deploy the real upstream `IdentityRegistryUpgradeable`.
4. Have the proxy owner call `upgradeToAndCall(real, initialize())`, establishing
   initializer version 2, then assert `getVersion() == "2.0.0"`.
5. Use a distinct agent owner to call empty `register()`, derive the agent ID
   from its confirmed `Registered` event, and publish the self-referencing
   Chicago profile with `setAgentURI`.

The demo separately asserts the ERC-1967 implementation, registry upgrade admin,
and `ownerOf(agentId)`. The registry admin governs upgrades in this local
deployment; the agent owner governs that token's profile. Neither role is
presented as service quality, endorsement, or public deployment governance.

The acceptance path verifies the original profile, rejects altered URI/card and
wrong full references, rejects another operator's update, accepts the owner's
endpoint/profile update, interprets the old profile only at its original block,
and demonstrates ownership transfer invalidating the old declared owner until
the new owner republishes.

## Reference provenance

`vendor/erc-8004/` contains unmodified MIT-licensed copies of
`HardhatMinimalUUPS.sol` and `IdentityRegistryUpgradeable.sol` from public
ERC-8004 reference commit
`b9e466c250744a7e06b13dff9d3c2844ed64f825`. Their SHA-256 hashes are recorded
and checked before every compile. `ERC1967Proxy.sol` is compiled from the exact
`@openzeppelin/contracts@5.4.0` package and is hash-checked too.

Compilation uses solc-js 0.8.24, Shanghai EVM output, optimizer enabled at 200
runs, and `viaIR: true`, matching the pinned reference settings. Run
`npm run contracts:check` to inspect the source and compiled-artifact hashes.
This narrow local bootstrap is test machinery, not a general installer or a
recommended public deployment script.

The pinned solc package declares legacy `tmp@0.0.33`. `package.json` narrowly
overrides only solc's `tmp` dependency to patched `tmp@0.2.7` without changing
the compiler. solc's actual `fileSync({ postfix: '.smt2' })` usage was checked
against 0.2.7, including file creation, read/write, cleanup callback, and postfix
behavior. Clean installation and `npm audit` report no vulnerabilities, while
the enforced compiled-artifact hashes confirm that the override does not change
compiler output.

## Identity boundary

- Registration documents are base64 `application/json` data URIs capped at
  32 KiB of decoded bytes.
- AgentCards are capped at 64 KiB and validated only against City's selected A2A
  0.3 subset; this is not a full A2A conformance claim.
- `cardDigest` is Keccak-256 over the exact supplied AgentCard bytes.
- Verification also reports `agentUriDigest` over the exact UTF-8 token URI and
  `registrationDigest` over the exact decoded registration bytes. It never hashes
  a JSON reserialization for these commitments.
- `ownerAtPublication` is checked against `agentOwner` at the supplied block. It
  is a duplicate binding, not an independent source of authority. A profile from
  an earlier owner fails against a later-owner snapshot.
- `readIdentitySnapshot` checks the configured RPC chain ID, chooses one numbered
  block, reads `ownerOf` and `tokenURI` at that block, and checks the block hash
  again before returning. It rejects a hash change during the read.
- A successful result describes RPC-derived evidence at the reported block. It
  is not a cryptographic state proof, and a later reorganization can supersede
  it. Local confirmation depth is reported as observation, not economic
  finality.
- A successful result does not claim that an agent is currently live, safe,
  trusted, endorsed, synchronized by an Index, or producing service results.
- `receiptSigner` is declared in the profile only. No receipt or signing model is
  implemented here.

The broader City vision—finding a specialist, invoking it, inspecting provenance,
and leaving portable feedback—remains future work. Public-chain writes, Index
connectors, service adapters, signing schemes, and reputation remain outside this
slice.

## Source layout

- `src/identity/profile.ts`: registration and AgentCard codecs, byte limits, and
  exact-byte digest helper.
- `src/identity/verify.ts`: snapshot-bound, I/O-free profile verification.
- `src/identity/registry.ts`: chain-ID-checked, block-qualified registry reads.
- `src/demo/`: pinned contract compilation, owned-Anvil lifecycle, and the local
  acceptance story.
- `src/cli.ts`: plain and JSON command output with nonzero failure status.
- `test/identity/`: public fixtures, unit tests, and the actual Anvil integration
  suite.
- `vendor/erc-8004/`: pinned upstream Solidity sources and provenance.

Licensed under the MIT License.
