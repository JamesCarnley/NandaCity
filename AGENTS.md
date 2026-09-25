# Contributor guidance

## Required checks

Run `npm run check` before handing off a change. It includes the owned Anvil
and two-Index integration suites: Anvil 1.7.1 must be on `PATH`, Docker must be
available, and `NANDA_INDEX_CHECKOUT` must point to a clean checkout of the
public pinned Index commit in `src/demo/indexProcesses.ts`. The harness builds
that source before launching it. Tests use Node's test runner through `tsx`
under `test/identity/`, `test/discovery/`, and `test/interaction/`.

Tests should exercise the real codec and verifier with complete literal fixtures.
For behavior changes, add a focused failing test first, observe the expected
failure, then implement the smallest passing change. Do not replace byte-level or
authority checks with mocks.

## Current code boundary

This repository currently owns the identity/profile foundation, local
discovery demonstration, and pure signed-interaction format:

- bounded ERC-8004 registration-v1 data-URI decoding and encoding;
- City's strict `x-nandacity` application profile;
- the selected minimal A2A 0.3 AgentCard shape;
- Keccak-256 commitments to exact supplied bytes; and
- pure verification against a caller-supplied authority snapshot;
- block-qualified reads from an explicitly configured identity registry;
- an owned, ephemeral Anvil deployment of the pinned reference registry;
- bounded configured-origin Index search and immutable observation reads;
- independently derived declaration/filter checks against separately obtained
  chain authority and exact AgentCard bytes, within a caller-selected chain and
  registry domain; and
- a local two-Index fixture using distinct disposable PostgreSQL databases;
- bounded exact-byte request/acceptance/completion codecs and EIP-712 EOA
  signatures with a separate owner-published runtime receipt signer; and
- pure linked-evidence checks over explicit profile, current-authority,
  continuity, answer-byte and observation-clock inputs; and
- an owned loopback A2A 0.3 JSON-RPC subset with durable `message/send` and
  `tasks/get` tasks; and
- one synthetic Chicago Index → AgentCard → A2A journey with separately
  generated owner/runtime/caller keys and an independent-process report; and
- six synthetic Chicago/Boston service journeys, three alternatives per city,
  with a separate Node process rechecking seven signed cases against the live
  owned loopback chain and exact cards before fixture teardown; and
- a self-contained static HTML comparison with unabridged evidence JSON; and
- a City-authored separate Node client process that owns an ephemeral caller key,
  discovers one of three local candidates per city through both real Indexes,
  invokes the published loopback A2A service, and exports evidence the parent
  independently rechecks before cleanup.

Do not describe snapshot verification as current chain truth, liveness, safety,
trust, or endorsement. `ownerAtPublication` must remain subordinate to the
snapshot's `agentOwner`, so ownership transfer invalidates an unchanged old-owner
profile.

Do not turn caller-supplied continuity or current-profile inputs into claims
of independently proven chain history. A signer-authored time is not proof of
pre-retirement existence. Signature validity is distinct from authority and
semantic quality. See [the City interaction format](docs/interaction-format.md).

Do not broaden the local write path to a public or non-loopback RPC. The demo
fetches AgentCards only from its own exact loopback origin/paths; arbitrary
external card fetching is not supported. Index rows are candidates, not authority.
Public-chain writes, deployed A2A service operation, reputation, and an
interactive UI remain outside this boundary. The static HTML report is a
read-only artifact, not an interactive selection UI. The loopback task service implements only
`message/send` and `tasks/get`; body signatures do not authorize polling, and
the subset is not a complete A2A implementation.
The journey JSON retains original evidence, but its stopped ephemeral Anvil is
not a durable authority source; do not claim that later parties can independently
re-read chain history from the export alone.
The comparison's distinct verifier process shares the same test host and owned
chain; it does not prove independent operator custody, live city facts, or
semantic quality. The interactive UI and reputation policy remain unbuilt.

## Public repository hygiene

Keep code, tests, fixtures, documentation, commit messages, issues, and pull
requests safe for a public audience. Never add secrets, credentials, account
identifiers, private messages, private planning/research, personal material, or
links to restricted sources. Use synthetic public test data only. Do not commit
`.env` files; `.env.example` is the only allowed template form.
