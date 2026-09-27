# Ranking evidence composition

`readRankingEvidence` is City's bounded raw-input adapter for the pure ranking
calculator. It accepts configured chain/Identity/Reputation provenance, one
numbered observation, exactly two loopback Index origins, selected agents,
accepted reviewer policy, caller-private bundle paths, optional explicit curator
inclusions, and optional native Town bundle directories.

The adapter independently authenticates Reputation activation and accepted-pair
counters, Index candidate coordinates and retained public bytes, current Identity
profiles and exact loopback cards, historical signed evidence at its original
numbered profile basis, authority epochs, and native Town observations. One
routed caller/deadline signal and one owned 120-second `RankingReadBudget` bound
all nested work, including native Town subprocesses. The adapter then
runs `calculatePolicy` and performs an additional uncached read of the exact
observation block as its last external read.

For v0.2 feedback, it also hashes the original validated private bundle bytes and
independently composes committed-before-runtime-retirement qualification. Even
same-epoch v0.2 feedback needs a matching bundle commitment. Missing bytes remain
unknown; substituted bytes cannot inherit the legacy v0.1 path. A retained
public negative review is not erased by a wrong private bundle: the adapter keeps
its public signature/publication facts, withholds uncommitted private projections,
and leaves policy eligibility unresolved rather than declaring a newcomer. The earliest
canonical matching document anchor supplies one qualification/basis shared by all
duplicates; later publications do not refresh age or bypass revocation. Retired
v0.1 remains excluded. Transfers, deauthorization/reactivation, incomplete history
and reorgs cannot qualify runtime carry-forward. The epoch remains `retired`.
The sanitized slot sidecar exposes commitment classification, controlled reasons
and public digest/block bases only. This work borrows the same aggregate read
budget; neither caller verdicts nor Index assertions establish qualification.

```ts
import { readRankingEvidence } from '../src/reputation/evidence.js';

const result = await readRankingEvidence({
  rpcOrigin,
  provenance,
  identityDomain,
  cardOrigin,
  observation: { blockNumber, blockHash },
  indexes: [{ origin: indexA, source }, { origin: indexB, source }],
  policy,
  scope,
  services,
  privateBundleFiles,
  curatorInclusions,
  townRuntime,
});
```

Invalid configuration throws before I/O. Missing, rejected, retired, revoked,
or incomplete evidence is retained as an unfavorable or unknown finding; it is
not converted into positive evidence. Authenticated slots that cannot be safely
represented by the calculator, including conflicting same-hash document
projections, remain in the sidecar and make only their affected service histories
partial. Authenticated publications whose raw rubric or format is explicitly
incompatible are retained as ineligible rather than treated as missing possibly
relevant evidence. Town admissions use service-and-bundle-bound IDs. If a
qualified or rejected Town observation contains a field outside the calculator's
stricter key/digest grammar, it remains in that service's Town sidecar with a
controlled diagnostic and is omitted from policy input rather than aborting the
whole composition. If the final numbered-block read changes, fails, or exceeds
the shared budget, both `policyInput` and `policyResult` are `null`. The sanitized
sidecar remains available with controlled diagnostics.

The output never includes private bundle bytes or paths, Town retained request or
card Base64, local runtime paths, native errors, keys, preverified profiles, or
caller-supplied verdicts. Curator inclusions are explicitly labeled `supplied`;
profile, history, review, and Town projections are `adapter-observed`.

## Qualification boundary

The result is `rpc-derived-not-state-proof`. Its two Indexes and RPC reads are
bounded and independently checked, but they do not prove global Index coverage,
chain finality, independent operators, service quality, or semantic correctness.
The composer enumerates accepted reviewers only. A separately inspected unknown
reviewer remains Index-reported, incomplete, and unweighted.

Focused reproduction requires Node 24, Anvil 1.7.1, the pinned clean Index
checkout, and the pinned clean Town checkout with Python 3.12.13:

```sh
node --import tsx --test test/reputation/evidence.test.ts
NANDA_INDEX_CHECKOUT=/absolute/index \
NANDATOWN_CHECKOUT=/absolute/town \
NANDATOWN_PYTHON=/absolute/town/.venv/bin/python \
node --import tsx --test --test-concurrency=1 test/reputation/evidence.integration.test.ts
```
