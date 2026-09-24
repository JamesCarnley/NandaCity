# NANDA City

NANDA City provides an identity/profile foundation, a real local ERC-8004
registry demonstration, and a two-Index local discovery fixture. It does
**not** provide public-chain deployment, real operator onboarding, service
invocation, receipts, reputation, a user interface, or a deployed service.

The companion [NANDA Index fork](https://github.com/JamesCarnley/nanda-index-v2)
provides exact per-service filtering and optional, read-only ERC-8004 following.
The local City fixture publishes six profiles on its own Anvil and launches two
actual Index processes with separate PostgreSQL databases and followers. The
Index remains useful without Ethereum or reputation. See [discovery details](docs/discovery.md).

The codec validates an embedded ERC-8004 registration-v1 document, City's
namespaced profile fields, and the selected minimal A2A 0.3 AgentCard shape. The
pure verifier binds those exact bytes to a caller-supplied authority snapshot.
The local adapter can obtain that snapshot from one block-qualified RPC basis;
it does not fetch an AgentCard URL.

## Requirements

- Node.js 24 or newer
- npm
- Anvil 1.7.1 from Foundry, on `PATH`, for integration checks and the demo
- Docker on a local Unix socket, with the `postgres:16` image available (or
  permission to pull it), for the two-Index integration check and demo
- A clean checkout of public `JamesCarnley/nanda-index-v2` at pinned commit
  `94dca70d86fcd915d8f6e46442e1e3a71ebb9ce7`, with `npm ci` run in its
  `server/` directory

The earlier identity-only process workflow was verified on macOS and in
[historical Linux CI](https://github.com/JamesCarnley/NandaCity/actions/runs/35251688937),
including actual-Anvil tests. That run predates the two-Index discovery fixture;
it is not Linux evidence for this milestone. Install the pinned Foundry release with:

```sh
foundryup --install v1.7.1
```

No paid account, hosted RPC, wallet, API key, or environment secret is needed.

## Setup and checks

```sh
git clone https://github.com/JamesCarnley/nanda-index-v2 /absolute/path/to/nanda-index-v2
git -C /absolute/path/to/nanda-index-v2 checkout 94dca70d86fcd915d8f6e46442e1e3a71ebb9ce7
npm ci --prefix /absolute/path/to/nanda-index-v2/server
npm ci
export NANDA_INDEX_CHECKOUT=/absolute/path/to/nanda-index-v2
npm test
npm run test:integration
npm run contracts:check
npm run demo:identity
npm run --silent demo:identity -- --json
npm run typecheck
npm run build
npm run check
npm run demo:discovery -- --index-checkout "$NANDA_INDEX_CHECKOUT"
```

`NANDA_INDEX_CHECKOUT` is required for `npm run test:integration` and
`npm run check`. Supply the checkout's canonical absolute path (for example,
macOS `/private/tmp/...`, not its `/tmp/...` symlink; `realpath` can show it).
The checkout must have the exact
pinned commit and no tracked/untracked changes; the harness rebuilds its Index
server from source before launch. The tests do not silently skip Anvil, Docker,
or the Index checkout. `npm run check` runs typechecking, all unit tests, the
production build, and both real-chain integration suites. Generated TypeScript
files are written to `dist/` and are not committed.

Before any Docker mutation, the demo resolves the selected Docker endpoint
(`DOCKER_CONTEXT` takes precedence over `DOCKER_HOST`, otherwise the saved
context is inspected). Only an absolute `unix:///...` socket endpoint is
supported; SSH, TCP (including loopback TCP), and other endpoint schemes are
refused. The resolved endpoint is pinned with `--host` for creation, inspection,
execution, and cleanup; the user's global context is never changed. A local
Unix socket cannot prove there is no user-arranged forwarding behind it: this
is an endpoint restriction, **not physical-host attestation**.

Anvil and nested Index resources share one SIGINT/SIGTERM cancellation scope,
installed before startup. Cancellation prevents new acquisitions; an acquisition
already in flight is awaited and recorded before teardown. All recorded children
and the ownership-labeled, uniquely named container are attempted before the
original signal is re-raised. The name also permits ownership-checked recovery
when Docker creates the container but fails to return its ID. Cleanup failures
are reported, never treated as successful cleanup. Repeated signals do not skip
cleanup or extend its 180-second hard shutdown deadline; expiry reports that
resources may remain. SIGKILL or an OS crash cannot run this cleanup.

Embedded `withOwnedAnvil` callbacks receive the shared lifecycle as their second
argument; `withOwnedIndexes` exposes it as `owned.lifecycle`. Callbacks must await
their work and cooperate with `lifecycle.signal` or `lifecycle.check()`. Nested
scopes share the same owner; HTTP requests and convergence loops in the supplied
demos observe cancellation. Teardown does not race an unawaited setup callback.

`npm run demo:identity` prints a plain summary. Add `--json` as shown above for
machine-readable output; `--silent` suppresses npm's lifecycle banner so stdout
is JSON only. A failed acceptance assertion exits nonzero.

## What the identity demonstration does

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
deployment, real service adapters, signing schemes, and reputation remain outside
this slice. The local Index connector and independent City verification are
demonstrated; they are not a production metadata fetcher or a trust verdict.

## Source layout

- `src/identity/profile.ts`: registration and AgentCard codecs, byte limits, and
  exact-byte digest helper.
- `src/identity/verify.ts`: snapshot-bound, I/O-free profile verification.
- `src/identity/registry.ts`: chain-ID-checked, block-qualified registry reads.
- `src/demo/`: pinned contract compilation, owned-Anvil lifecycle, and the local
  identity and two-Index acceptance stories with owned local resources.
- `src/discovery/`: bounded Index search/observation reads and independent
  declaration/profile verification.
- `docs/discovery.md`: source pin, execution, coverage, and limits.
- `src/cli.ts`: plain and JSON command output with nonzero failure status.
- `test/identity/`: public fixtures, unit tests, and the actual Anvil integration
  suite.
- `vendor/erc-8004/`: pinned upstream Solidity sources and provenance.

Licensed under the MIT License.
