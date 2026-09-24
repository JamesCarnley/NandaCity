# Contributor guidance

## Required checks

Run `npm run check` before handing off a change. It includes the owned Anvil
and two-Index integration suites: Anvil 1.7.1 must be on `PATH`, Docker must be
available, and `NANDA_INDEX_CHECKOUT` must point to a clean checkout of the
public pinned Index commit in `src/demo/indexProcesses.ts`. The harness builds
that source before launching it. Tests use Node's test runner through `tsx`
under `test/identity/` and `test/discovery/`.

Tests should exercise the real codec and verifier with complete literal fixtures.
For behavior changes, add a focused failing test first, observe the expected
failure, then implement the smallest passing change. Do not replace byte-level or
authority checks with mocks.

## Current code boundary

This repository currently owns the identity/profile foundation and local
discovery demonstration:

- bounded ERC-8004 registration-v1 data-URI decoding and encoding;
- City's strict `x-nandacity` application profile;
- the selected minimal A2A 0.3 AgentCard shape;
- Keccak-256 commitments to exact supplied bytes; and
- pure verification against a caller-supplied authority snapshot;
- block-qualified reads from an explicitly configured identity registry;
- an owned, ephemeral Anvil deployment of the pinned reference registry;
- bounded configured-origin Index search and immutable observation reads;
- independently derived declaration/filter checks against separately obtained
  chain authority and exact AgentCard bytes; and
- a local two-Index fixture using distinct disposable PostgreSQL databases.

Do not describe snapshot verification as current chain truth, liveness, safety,
trust, or endorsement. `ownerAtPublication` must remain subordinate to the
snapshot's `agentOwner`, so ownership transfer invalidates an unchanged old-owner
profile.

Do not broaden the local write path to a public or non-loopback RPC. The demo
fetches AgentCards only from its own exact loopback origin/paths; arbitrary
external card fetching is not supported. Index rows are candidates, not authority.
Public-chain writes, invocation, receipt signing, reputation, and UI work remain
outside this boundary. `receiptSigner` is only a declared profile field here.

## Public repository hygiene

Keep code, tests, fixtures, documentation, commit messages, issues, and pull
requests safe for a public audience. Never add secrets, credentials, account
identifiers, private messages, private planning/research, personal material, or
links to restricted sources. Use synthetic public test data only. Do not commit
`.env` files; `.env.example` is the only allowed template form.
