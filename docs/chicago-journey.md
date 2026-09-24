# First owned Chicago journey

`npm run demo:journey -- --index-checkout /absolute/path/to/nanda-index-v2`
runs a synthetic, local-only end-to-end service interaction. The checkout must be
clean at the [pinned public Index commit](discovery.md). Node 24, Anvil 1.7.1,
Docker on a local Unix socket, and the `postgres:16` image are required. No
paid account, hosted RPC, public-chain transaction, personal wallet, OpenClaw,
live city API, or model inference is used.

Add `--json` for the full result and original evidence envelopes:

```sh
npm run --silent demo:journey -- --index-checkout /absolute/path/to/nanda-index-v2 --json > journey.json
```

The command starts its own Anvil, ERC-8004 reference registry, two pinned
NANDA Index processes and databases, exact AgentCard server, and loopback A2A
task service. It creates **different** disposable owner, runtime-signer, and
caller keys. The owner publishes the runtime signer; the caller signs the
request; only the runtime signer signs acceptance and completion. An Index
candidate is checked against an independently read, block-qualified registry
record and the exact AgentCard bytes before the client sends to the card's
exact allowlisted loopback URL.

The service persists acceptance before returning a submitted Task. The caller
polls `tasks/get` for a synthetic evening plan, then performs a second request
that deliberately fails **after acceptance**. Both original request,
acceptance and completion envelopes, the exact answer bytes, task and
authority observations are exported. The report separates discovery,
cryptographic validity, authorized signing, acceptance, execution and answer
byte binding. It marks semantic quality **not tested**. A signed failed
completion is usable evidence of a failure, not a successful service result.

For a second verification, the demo writes its exported JSON to a temporary
file and launches `src/demo/verifyJourneyCli.ts` in a separate Node process.
That verifier takes the trusted chain ID and registry from the owned setup,
not from an Index row; independently re-reads the exact observation block and
the signed request's potentially later authority-basis block, plus the current
block; re-fetches the exact card from an allowlisted origin; and uses
its own clock. A changed answer byte is rejected by the signed digest check.
The temporary file and owned resources are removed at the end. The printed
JSON is a portable evidence artifact, but **a later independent authority
check requires the same chain to remain available**; this ephemeral Anvil is
not a durable evidence registry or an Ethereum state proof. The raw envelopes
can still be inspected offline, but the stopped local chain cannot be
re-created from the JSON alone.

The verifier command is also available to an independently started process
while its local chain and card server are running:

```sh
node --import tsx src/demo/verifyJourneyCli.ts \
  --evidence /absolute/path/journey.json \
  --rpc-url http://127.0.0.1:PORT \
  --card-origin http://127.0.0.1:PORT \
  --chain-id 31337 --registry 0xREGISTRY_ADDRESS
```

The RPC and card origins are required to be exact `127.0.0.1` HTTP origins.
The command needs independently configured trusted domain inputs; it refuses
to adopt a registry from the exported Index candidate. Its output is a JSON
report. This path demonstrates the A2A `message/send` and `tasks/get` subset,
not full A2A conformance, deployed HTTP authentication, live data correctness,
provider safety, reputation, or endorsement. Body signatures do not authorize
task polling, which remains loopback-only.
