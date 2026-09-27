# Contributor guidance

## Required checks

Run `npm run check` before handing off a change. It includes the owned Anvil
and two-Index integration suites: Anvil 1.7.1 must be on `PATH`, Docker must be
available, and `NANDA_INDEX_CHECKOUT` must point to a clean checkout of the
public pinned Index commit in `src/demo/indexProcesses.ts`. The harness builds
that source before launching it. Tests use Node's test runner through `tsx`
under `test/identity/`, `test/discovery/`, `test/interaction/`, `test/feedback/`
and `test/reputation/`. Unit and full checks also require `NANDATOWN_CHECKOUT`
at the clean public Town pin and `NANDATOWN_PYTHON` pointing to the Python 3.12.13
virtual-environment entry, not its resolved global target. Use the exact pins
and separate editable-install setup in [README](README.md#setup-and-checks) and
[the CI workflow](.github/workflows/unit.yml).

Tests should exercise the real codec and verifier with complete literal fixtures.
For behavior changes, add a focused failing test first, observe the expected
failure, then implement the smallest passing change. Do not replace byte-level or
authority checks with mocks.

## Current code boundary

This repository owns local identity, discovery, signed interaction, explained
ranking and generated-credential account/recovery demonstrations:

- bounded ERC-8004 registration-v1 data-URI decoding and encoding;
- City's strict `x-nandacity` application profile;
- the selected minimal A2A 0.3 AgentCard shape;
- Keccak-256 commitments to exact supplied bytes; and
- pure verification against a caller-supplied authority snapshot;
- block-qualified reads from an explicitly configured identity registry;
- bounded RPC-derived reference-registry continuity over subject URI/transfer
  and global upgrade events, with explicit known-deployment provenance and RPC
  completeness assumptions (not a log/state proof);
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
- strict exact-byte reviewer-signed feedback, a pure historical evidence verifier,
  and a bounded full-envelope document codec; and
- owned loopback Reputation 2.0.0 publication/revocation with exact contract
  projections, original-block profile verification, restart-safe prepared raw
  transactions, and receipt/event observations (not canonical read-back); and
- a separate read-only publication reader checking exact document/event projection,
  numbered-block canonicality and registry storage through a configured RPC; its
  findings are RPC-derived, not finality or cryptographic state proofs, and do not
  establish historical signature existence; and
- a strict caller-private supporting-bundle codec and read-only historical
  composition that rebuilds original authority at the request's signed numbered
  basis, separately from publication/revocation and without a live provider;
  private requests/cards are not returned in its findings or uploaded to Indexes; and
- v0.2 feedback commitments to exact private supporting-bundle bytes, qualified
  pre-retirement history composition and conservative ranking carry-forward;
  absent/substituted commitments cannot supply private authority findings,
  transfers never qualify, and legacy retired v0.1 remains excluded; and
- a bounded stock-Safe adapter with separate preparation/approval/execution,
  durable two-service onboarding, a separate existing-ID migration journal,
  encrypted V3 backup and [clean-process exit proof](docs/safe-exit.md);
  immutable deployment provenance stays separate from current owner policy,
  and the retained-attacker revocation proof is separately labelled; and
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
  independently rechecks before cleanup; and
- a pure explained reputation calculator plus a bounded raw-input ranking
  composer that independently derives current profiles, accepted-reviewer
  coverage, retained historical evidence, authority epochs, and native Town
  admissions at one frozen observation; and
- a two-Index feedback retention drill, bounded raw-evidence reader and separate
  historical verifier, including provider loss, reorg, revocation and empty-DB
  missing-byte evidence. Index coverage remains self-reported, not complete history.

Do not describe snapshot verification as current chain truth, liveness, safety,
trust, or endorsement. `ownerAtPublication` must remain subordinate to the
snapshot's `agentOwner`, so ownership transfer invalidates an unchanged old-owner
profile.

Do not turn caller-supplied continuity or current-profile inputs into claims
of independently proven chain history. A signer-authored time is not proof of
pre-retirement existence. Signature validity is distinct from authority and
semantic quality. See [the City interaction format](docs/interaction-format.md).
Committed history does not prove quality, use/compromise time, finality or future
availability. Safe support is local generated EOA custody, threshold 1-of-2,
with a separate runtime signer and non-owner payer; it is not passkey/connected
wallet UX, ERC-1271 caller support or independent-operator custody. Pre-send
canonical checks are observations, not atomic protection against later state
changes. A malicious owner removing the backup defeats this loss-recovery model.

Do not broaden the local write path to a public or non-loopback RPC. The demo
fetches AgentCards only from its own exact loopback origin/paths; arbitrary
external card fetching is not supported. Index rows are candidates, not authority.
Public-chain writes, deployed A2A service operation, and an
interactive UI remain outside this boundary. The static HTML report is a
read-only artifact, not an interactive selection UI. The loopback task service implements only
`message/send` and `tasks/get`; body signatures do not authorize polling, and
the subset is not a complete A2A implementation.
The journey JSON retains original evidence, but its stopped ephemeral Anvil is
not a durable authority source; do not claim that later parties can independently
re-read chain history from the export alone.
The comparison and ranking consumers share the same test host and owned
chain; they do not prove independent operator custody, live city facts, or
semantic quality. The interactive UI, public-chain ranking service, and
operator-separated evidence adapters remain unbuilt.
Local feedback publication alone is not independent canonical read-back, document
availability, historical signature ordering, service quality, or Index retention.
The separate retention drill supplies bounded availability evidence, not global
coverage or permanent storage. Acceptance is request acceptance, not provider permission to review. Keep the
historical verifier pure. See [local feedback publication](docs/feedback-publication.md).

## Public repository hygiene

Keep code, tests, fixtures, documentation, commit messages, issues, and pull
requests safe for a public audience. Never add secrets, credentials, account
identifiers, private messages, private planning/research, personal material, or
links to restricted sources. Use synthetic public test data only. Do not commit
`.env` files; `.env.example` is the only allowed template form.
