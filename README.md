# NANDA City

NANDA City demonstrates how your personal AI can discover and work with independent
expert agents, while their operators retain control of their identity and service
information.

Imagine asking your agent to plan an evening in Chicago. It finds specialists,
compares their reputations, asks one for help, and leaves feedback that other
agents can use.

## Why City?

- **Expertise without the setup.** Specialists handle domain knowledge and
  underlying service integrations for you.
- **Operator-owned identity and profiles.** Providers can change hosting or update
  their services without starting over in every directory.
- **Reputation that travels.** Signed feedback tied to interactions can inform
  choices across directories and clients, instead of being trapped in one platform.
- **Discovery without one gatekeeper.** Different NANDA Indexes can find the same
  services. Clients check listings against operator-controlled records.

**NANDA Index provides search. Ethereum supplies shared ownership records and
feedback commitments that neither Index controls.** Clients verify listings and
decide how to weigh signed feedback.

This is a local prototype with simulated operators and fictional city plans.
The network mechanics run locally; live data integrations, bookings and payments
are not demonstrated here. City is a reference application, not an official
NANDA release. [Read the one-minute overview](docs/overview.md).

## Try the local story

The web demo is **synthetic**, with fictional plans for Chicago and Boston. Each
of three simulated operators owns both city services. They are competing choices,
not three mandatory roles. The generated Safe owners all live on the same host;
this is not independent custody or independent-customer reputation.

After installing the fixture prerequisites below:

```sh
npm ci
export NANDA_INDEX_CHECKOUT=/absolute/path/to/pinned/nanda-index-v2
npm run demo:doctor
npm run demo:session -- --index-checkout "$NANDA_INDEX_CHECKOUT"
```

Open the exact `http://127.0.0.1:...` URL printed by the launcher. Initial startup
builds the pinned Index and prepares disposable local resources; allow about a
minute. Optionally add `--port 3000`. No account, API key or public-chain wallet is
needed. Node 24+, Anvil 1.7.1, local Docker and the clean pinned Index checkout are
required. **Town and its Python environment are not needed for this
curator-admitted fixture.** Doctor reports their separate full-check/native-Town
prerequisites without blocking this demo or claiming a Town pass.

1. Compare Chicago or Boston. Inspect all three alternatives and select one;
   selection alone sends nothing.
2. Ask it. Inspect the fictional dinner, activity, route, budget and gaps, alongside
   separately observed sent, accepted and completed stages.
3. Rate its usefulness. Publication, canonical read-back, Index retention and
   policy contribution are separate findings. A new reviewer remains unweighted.
4. Open **Experiments**. Take A offline, alter A's reply, or restore A; each
   control immediately rechecks the same city and shows A/B verification and
   remaining services beside the controls and map. The advanced B control lets
   you test both-down discovery. Open **Ownership** to migrate an operator using
   its generated backup: both city IDs remain while owner/runtime/endpoints change.
5. Recompute the frozen ranking in a fresh process. This uses the same verifier
   on the same host, not an independent implementation or an offline proof. The
   separate card host and local RPC remain required after provider endpoints stop.
   Run the explicitly separate synthetic HTTPS-origin comparison when desired;
   it is never an automatic Ethereum-failure fallback.

Use **Reset this local session** to cancel work, await cleanup and acquire a fresh
generation. The page shows starting/resetting states and GET refreshes never
repeat a call. Ctrl-C waits for owned resource cleanup and stops the listener.
By default this binds only `127.0.0.1`, validates Host/Origin and per-generation
action tokens, and is a same-host demo. Do not remove unrelated Docker containers.

### Bounded shared-fixture hosting

The credential-free fixture has an explicit low-traffic HTTPS mode for a trusted
demo group behind a reverse proxy. It keeps one owned chain, specialist pool and
real Index pair, while assigning each browser a private journey, action token,
discovery/selection history, A2A task mapping and reset boundary:

```sh
export NANDA_CITY_BIND_HOST=172.18.0.1
export NANDA_CITY_PUBLIC_ORIGIN=https://city.example.org
export NANDA_CITY_MAX_SESSIONS=12
export NANDA_CITY_SESSION_SECONDS=3600
npm run demo:session -- --index-checkout "$NANDA_INDEX_CHECKOUT" --port 39123
```

`NANDA_CITY_MAX_SESSIONS` must be 2–32 and requires the exact canonical HTTPS
origin. `NANDA_CITY_SESSION_SECONDS` is an absolute 1-minute to 24-hour browser
session lifetime. Cookies are random, Secure, HttpOnly and SameSite=Strict;
cross-browser action tokens are rejected. The proxy is the only public listener:
Anvil, PostgreSQL, Indexes, A2A services and Docker stay private.

This mode does not clone the protocol infrastructure. Feedback and recovery are
real shared-chain changes and therefore become visible to other browsers after a
fresh read. Index fault actions are serialized: City applies the real stop or
alteration, records that browser's verified observation, restores the Index, and
only then admits the next browser mutation. The permanent stop-all-provider
control is omitted; each browser can still run the signed provider-failure path.
This is a bounded synthetic demo boundary, not general-purpose multi-tenant
hosting. Licensed and OpenClaw modes intentionally reject the browser pool.

Saved HTML/JSON are read-only public snapshots, without action tokens or mutation
forms. Authored fixture answers remain exportable. Configured licensed sessions
can use the same server API, with bounded transient display, intact attribution,
expiry and receipts-only export. There is **no licensed CLI launcher or concrete
licensed-source model adapter**: source/model terms, accounts, pricing and spending approval are
still owner-gated. Expired answers cannot be semantically replayed; receipts and
earlier byte-check observations remain. A hostile recipient can still copy visible
content. No live-provider utility or Sepolia rehearsal is claimed.

### Add real specialist reasoning

With the [dedicated OpenClaw roster](runtime/openclaw/README.md) configured and
signed in, use the same demo with real model calls:

```sh
npm run demo:openclaw -- --index-checkout "$NANDA_INDEX_CHECKOUT" --port 3000
```

Set your preferences and example budget before asking. Each specialist selects
and explains a complete plan from the authored fictional options. Its reasoning
is labelled separately from the catalog facts. The signed A2A journey and feedback
are real local executions; model opinions are not verified city knowledge.
Failures do not silently fall back to a canned answer. Tools are disabled at
OpenClaw configuration level, and no wallet keys or private evidence enter its
prompt. Only opt-in OpenClaw commands call the model; default tests
and the fixture demo do not.

See the [five-minute video walkthrough](docs/video-demo.md) for the story,
controls, rehearsal command and remaining live-data/public-chain gates.

## Current capabilities and evidence

The [local feedback retention drill](docs/feedback-retention.md) exercises a real
signed A2A failure, two separate Index databases, provider/source loss,
separate-process historical verification, reorg, revocation and empty-database
recovery. Run `npm run demo:feedback -- --index-checkout /absolute/path/to/nanda-index-v2`
(add `--json` for public evidence). This is synthetic same-host, RPC-derived
evidence, not ranking, complete history or independent-customer reputation.
The independent [opaque registry reader](docs/registry-observation.md) authenticates
one raw slot, including routed calls and non-text bytes, without implying City
feedback eligibility, known implementation provenance or ranking coverage.

NANDA City provides an identity/profile foundation, a real local ERC-8004
registry demonstration, a two-Index local discovery fixture, a signed
request/acceptance/completion format, and an owned loopback A2A task service.
It now includes one fixture-labeled Chicago journey and a six-service comparison
for Chicago and Boston through actual pinned NANDA Indexes and exact AgentCards,
with signed A2A evidence checked in a separate Node process while the local
chain and card server remain live. A self-contained static comparison report
can be exported with its unabridged evidence JSON. See
[the comparison guide](docs/six-service-comparison.md).
The [separate-client example](docs/external-client.md) runs a Node caller through
Index discovery, exact card verification, and signed A2A invocation for either
city, then the parent independently rechecks its exported evidence live.
Local reputation is implemented as an [explained policy](docs/reputation-policy.md)
with [bounded ranking evidence](docs/ranking-evidence.md) and independently read
[accepted-reviewer coverage](docs/reputation-coverage.md). Its synthetic same-host,
RPC-derived findings are not service quality, global history or independent trust.
The [Safe backup and exit drill](docs/safe-exit.md) adds separate preparation,
owner approval and non-owner execution, shared two-service onboarding, encrypted
backup restore and same-account endpoint/runtime migration. It uses generated
EOA-backed owners, threshold 1-of-2 and local infrastructure—not real custody,
connected-wallet/passkey or ERC-1271 caller UX. Public-chain deployment, live city
answers, real operator onboarding and deployed services remain
outside this prototype.

The opt-in [HTTPS-origin comparison](docs/origin-comparison.md) runs one synthetic
Chicago service through generic discovery in both real Indexes and the shared
HTTPS task runtime. A separate consumer verifies a retained negative review after
provider/archive loss. It uses a temporary local CA, current origin-key attribution
and a finite reviewer-declared snapshot—not independent historical authority.
Run `NANDA_INDEX_CHECKOUT=/absolute/path/to/pinned/index npm run demo:origin`.
Ethereum remains the default; no automatic authority fallback or native Town
origin pass badge is provided.

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
  `b9c6ccef4907c5dc3c7d9d898cf671207166f435`, with `npm ci` run in its
  `server/` directory
- For full checks and explicit native Town admission (not fixture launch):
  Python 3.12.13 and a clean checkout of public `JamesCarnley/nandatown` at
  `bf8f226b4d7ae9543bd73995c000c64c7dcd7e09`, installed editable into a separate
  private virtual environment; `python3.12` below must be that exact version

The checked-in [CI workflow](.github/workflows/unit.yml) provisions the pinned
Index/Town sources and runtimes, then runs `npm run check`: typechecking, units,
build and owned-chain/two-Index integration. This describes its configured gate,
not a claim about the latest run. Install the pinned Foundry release with:

```sh
foundryup --install v1.7.1
```

No paid account, hosted RPC, wallet, API key, or environment secret is needed.

## Setup and checks

```sh
git clone https://github.com/JamesCarnley/nanda-index-v2 /absolute/path/to/nanda-index-v2
git -C /absolute/path/to/nanda-index-v2 checkout b9c6ccef4907c5dc3c7d9d898cf671207166f435
npm ci --prefix /absolute/path/to/nanda-index-v2/server
git clone https://github.com/JamesCarnley/nandatown /absolute/path/to/nandatown
git -C /absolute/path/to/nandatown checkout bf8f226b4d7ae9543bd73995c000c64c7dcd7e09
python3.12 --version
(umask 077; python3.12 -m venv /absolute/path/to/town-venv)
/absolute/path/to/town-venv/bin/python -m pip install -e /absolute/path/to/nandatown
npm ci
export NANDA_INDEX_CHECKOUT=/absolute/path/to/nanda-index-v2
export NANDATOWN_CHECKOUT=/absolute/path/to/nandatown
export NANDATOWN_PYTHON=/absolute/path/to/town-venv/bin/python
npm test
npm run test:integration
npm run contracts:check
npm run demo:identity
npm run --silent demo:identity -- --json
npm run typecheck
npm run build
npm run check
npm run demo:discovery -- --index-checkout "$NANDA_INDEX_CHECKOUT"
npm run demo:journey -- --index-checkout "$NANDA_INDEX_CHECKOUT"
npm run demo:compare -- --index-checkout "$NANDA_INDEX_CHECKOUT"
npm run demo:report -- --index-checkout "$NANDA_INDEX_CHECKOUT" --html /absolute/output/comparison.html --evidence /absolute/output/evidence.json
npm run demo:external-client -- --index-checkout "$NANDA_INDEX_CHECKOUT" --city Chicago
npm run demo:external-client -- --index-checkout "$NANDA_INDEX_CHECKOUT" --city Boston --json
```

`NANDATOWN_CHECKOUT` and `NANDATOWN_PYTHON` are required for `npm test`,
`npm run test:integration` and `npm run check`; `NANDA_INDEX_CHECKOUT` is required
for the latter two. Keep `NANDATOWN_PYTHON` as the virtual environment's interpreter
entry path—do not replace it with the resolved global Python target. See the
[Town evidence boundary](docs/town-evidence.md). Supply canonical absolute
checkout paths (for example,
macOS `/private/tmp/...`, not its `/tmp/...` symlink; `realpath` can show it).
Both source checkouts must have their exact
pinned commits and no tracked/untracked changes; the harness rebuilds its Index
server from source before launch. The tests do not silently skip Anvil, Docker,
or the Index checkout. `npm run check` runs typechecking, all unit tests, the
production build, and the real-chain/Index integration suite. Generated TypeScript
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
- `receiptSigner` is a separate runtime key authorized only for City's signed
  acceptance and completion statements. It is not an owner or payment key.

The first owned Chicago journey finds and invokes a fixture specialist and
exports evidence plus an independent, stage-by-stage report. Portable feedback
and local explained ranking are implemented separately; real providers and live
city data remain future work. Public-chain writes, Index deployment, additional
caller signing schemes and transport authentication remain outside this slice.
The local Index connector and independent
City verification are demonstrated; they are not a production metadata fetcher
or a trust verdict. See the [journey](docs/chicago-journey.md) and
[loopback A2A boundary](docs/a2a-loopback.md).

## Source layout

- `src/identity/profile.ts`: registration and AgentCard codecs, byte limits, and
  exact-byte digest helper.
- `src/identity/verify.ts`: snapshot-bound, I/O-free profile verification.
- `src/identity/registry.ts`: chain-ID-checked, block-qualified registry reads.
- `src/demo/`: pinned contract compilation, owned-Anvil lifecycle, and the local
  identity and two-Index acceptance stories with owned local resources.
- `src/discovery/`: bounded Index search/observation reads and independent
  declaration/profile verification.
- `src/interaction/`: exact-byte statements, scoped EIP-712 signatures, and
  linked evidence verification.
- `src/a2a/`: owned loopback A2A 0.3 JSON-RPC subset and durable task store.
- `docs/discovery.md`: source pin, execution, coverage, and limits.
- `docs/interaction-format.md`: signed City interaction contract and limits.
- `docs/a2a-loopback.md`: implemented task-service wire, durability, and auth
  boundary.
- `docs/chicago-journey.md`: owned Index-to-A2A execution, independent evidence
  check, and limits.
- `src/cli.ts`: plain and JSON command output with nonzero failure status.
- `test/identity/`: public fixtures, unit tests, and the actual Anvil integration
  suite.
- `vendor/erc-8004/`: pinned upstream Solidity sources and provenance.

Licensed under the MIT License.
