# Local two-Index discovery

This is a reproducible local fixture, not a deployed City service. Its public
Index source pin is `JamesCarnley/nanda-index-v2` commit
`94dca70d86fcd915d8f6e46442e1e3a71ebb9ce7`. The pin is enforced in
`src/demo/indexProcesses.ts` and in Linux CI. Build artifacts ignored by Git
are not trusted: the harness runs `npm run build` from that source before each
launch.

## Run

Requires Node 24, Anvil 1.7.1, Docker, and an installed clean checkout of the
pinned public Index source. In the Index checkout, run `npm ci` in `server/`.
Then from City:

```sh
npm ci
NANDA_INDEX_CHECKOUT=/absolute/path/to/nanda-index-v2 npm run check
npm run --silent demo:discovery -- --index-checkout /absolute/path/to/nanda-index-v2
```

The demo command emits JSON with `mode: "local-fixture"`, City and Index source
commits, whether the City working tree was dirty, qualified registry, the two
contacted Index origins, final checkpoints, named acceptance booleans, limits,
and cleanup status. It exits nonzero if an assertion fails. JSON contains no
owner keys, database passwords, or private checkout paths.

The harness checks that the Index checkout is clean and at the exact pin. It
creates a labeled disposable PostgreSQL 16 container with two freshly named
databases, builds and starts two actual Index servers on loopback using
`BIND_HOST=127.0.0.1`, and gives each server a separately persisted follower.
Anvil uses an explicit zero-height genesis marker and randomly generated local
keys. The only AgentCard HTTP server and the tampering/RPC proxies also bind to
loopback. Child processes receive an explicit environment allowlist, not the
caller's `DATABASE_URL`, RPC credentials, or API keys. Cleanup closes owned
listeners/processes and deletes only the container whose recorded ID and label
match. Existing Docker containers, databases, wallets, and services are not
used or reset.

## What the acceptance demonstrates

- Three simulated owners register six profiles, one Chicago and one Boston
  service each. Each actual Index independently returns three per city.
- One owner changes a card and invocation endpoint once; both Indexes converge.
- A is stopped while B continues, then A restarts from its own database.
- Only A's owned database is dropped/recreated; its follower rebuilds without
  copying B's database.
- A labeled owned HTTP proxy changes the same displayed service name in A's
  search and observation responses. City's separately configured chain reader
  and exact card-byte verifier reject the changed metadata; authentic B remains
  usable. The rejection is not based on proxy-vs-echoed-origin comparison.
- Ownership transfer and inactive registration withdraw former eligible
  projections. A controlled RPC outage makes A's follower coverage unavailable
  while B remains available; an Anvil reorganization causes replay/convergence.

## Consumer boundary

`searchIndexes` contacts only one or two explicitly configured Index origins.
It reads `POST /api/ard/services/search` and same-origin
`GET /api/ard/identity-observations/:observationId`, limits each body to 2 MiB,
uses a five-second request deadline, refuses redirects and unexpected links,
and caps pagination at ten pages of 100 results. The client records the origin
actually contacted, retains each origin's coverage/errors, and never infers
catalog completeness from two Indexes agreeing. An unavailable origin or chain
read remains `unavailable`, not a negative service assertion.

`verifyDiscovery` is pure. It checks the exact URI and AgentCard bytes with
City's existing profile verifier, active status, a caller-supplied authority
snapshot, all normalized declaration fields, and the requested exact filters.
`verifyDiscoveryAtCurrentChain` obtains a fresh block-qualified snapshot from
an independently configured RPC before the pure check. An old record may still
verify against an explicitly old basis, but not against changed current URI or
ownership. Neither RPC evidence nor Index coverage is a cryptographic state
proof, liveness check, reputation judgment, or endorsement. The demo fetches
cards only from its own precise loopback origin and `/cards/<id>.json` paths;
production-safe external metadata transport is not implemented.

This milestone does not call A2A services, live city APIs, paid APIs, or public
chains. Real independent operators, mixed-key onboarding, feedback/portable
reputation, and the end-user selection experience remain future work.
