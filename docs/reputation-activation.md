# Reference Reputation activation

`deployReputationRegistryWithProvenance(client, wallet, identityRegistry)` returns
`{ address, provenance }` for the owned loopback fixture. Its existing
`deployReputationRegistry(...)` sibling still returns only an address. Both keep
the same loopback HTTP, matching read/write RPC, chain 31337 and Identity 2.0.0
ERC-721 guards. The provenance variant additionally requires numbered block
zero; use an owned Anvil with an explicit zero-height genesis marker. The legacy
address helper also works with a nonzero initial block.

Provenance contains the configured chain/genesis/Identity/proxy domain, deployer,
three direct CREATE coordinates and nonces, actual deployed runtime hashes,
pinned artifact/compiler provenance and the exact activation transaction/log.
It has no secrets, RPC URL or verification flag. Supply it as trusted fixture
configuration, never as first-seen authority from an Index.

```ts
const observed = await readReputationActivation({
  client: boundedReadClient,
  provenance: deployment.provenance,
  observation: { blockNumber, blockHash },
  signal,
  limits: { totalTimeoutMs: 60_000 }, // explicit; no automatic extension
});
```

The independent reader compiles the locally pinned reference to derive exact
creation inputs, proxy constructor arguments and activation calldata. It checks
transactions, successful full receipts, direct CREATE addresses, event positions,
initializers, runtime code, implementation slot, version and Identity link.
Implementation runtime hashes are **actual deployed code** pins: UUPS embeds its
implementation address, so the compiler's unpatched runtime template is not the
runtime hash. Proxy runtime has no such immutable and is also checked directly
against the pinned template.

The raw Upgraded scan includes every block from proxy creation through the end
of the observation block. Only constructor-to-bootstrap and the exact
activation-to-Reputation logs are allowed. A preactivation detour, no-op upgrade
or away/back upgrade is rejected even if final code/slot/version are unchanged.
All referenced numbered hashes, including genesis, are checked again at the end.
Missing archive data or a canonicality gap is never replaced with latest.

`activation` is `matched`, `mismatched`, `unsupported` or `unavailable`.
Only `matched` supplies `knownDeployment`, including the activation transaction
position and its Upgraded/Initialized log indices. The later counter adapter must
reject feedback allegedly inside that exact activation transaction; later
transactions in the same block remain eligible for ordinary authentication.
Non-matched findings cannot qualify registry counters. This reader returns no
feedback coverage, score, signature-existence claim or quality judgement.

## Bounded work and assumptions

Defaults: 30 seconds total including compilation, 5 seconds per request, 128 RPC
calls, 4,096 inclusive blocks in fixed 64-block chunks, 64 raw upgrade logs, 256
logs/receipt, 1 MiB receipt log payload, 64 KiB per log/input, 32 KiB runtime code,
1 KiB ABI return and 8 MiB cumulative relevant RPC payload. Configurable hard
ceilings are 60 seconds total, 256 calls, 1,024 logs/receipt and 2 MiB receipt
payload; other defaults are also their ceilings. Positive lower limits are
allowed. Bounds, cancellation and deadlines yield unavailable, not absence.

There are no reader retries. The caller must supply a transport with bounded
whole-response bytes and JSON parsing, no transport retries, and actual network
cancellation. Payload accounting here covers relevant code/input/log/topic/ABI
bytes, **not** entire HTTP responses. A timed-out PublicClient request may remain
in flight; synchronous fixed compilation cannot be interrupted while JavaScript
is blocked, but its elapsed time is checked before any subsequent RPC or result.
No compiler cache or worker system is introduced.

The later ranking composition must charge activation compilation and all its
reads to its shared elapsed/call/byte budget, and abort its invocation-scoped
transport on exit. A standalone activation check is not an aggregate budget.

Findings assume trusted configured pins, the configured RPC's canonical data and
complete matching log responses. They are RPC-derived observations, not
cryptographic state/log proofs, finality, or protection against a lying RPC or
privileged local-chain state mutation. The registry is upgradeable; unsupported
code requires deliberate review, not automatic acceptance.
