# NANDA City interaction format 0.1

This is City's application format for one evening-plan request. It is carried in
an A2A `DataPart`; A2A transport success alone says nothing about the plan's
quality. The format makes an interaction attributable and links a provider's
acceptance to its eventual outcome. It does not claim live data, endorsement,
independent timing, or general A2A conformance.

## Signed statements

There are three exact-byte JSON payloads, each with `version: "0.1"`:

| Kind | Required fields | Link |
| --- | --- | --- |
| `request` | `service`, `caller`, `interactionId`, `profileBasis`, `createdAt`, `deadline`, `input` | Original request bytes are committed by the caller. |
| `acceptance` | `requestDigest`, `acceptanceId`, `acceptedAt`, `deadline` | `requestDigest` is Keccak-256 of the signed request bytes; deadline equals the request deadline. No future answer digest is present. |
| `completion` | `acceptanceDigest`, `recordedAt`, `outcome` and the outcome-specific fields below | `acceptanceDigest` is Keccak-256 of the signed acceptance bytes. |

`service` is `{ "method": "erc8004", "agent": { "chainId": 31337,
"registry": "0x…", "agentId": "1" } }`. The identity is the chain,
registry and agent ID together, not an owner wallet. `caller` and the envelope's
`signer` use `{ "method": "eip155-eoa", "chainId": 31337,
"address": "0x…" }`. Other authority/signature methods are unsupported in
0.1; they are not silently interpreted as Ethereum identities.

`profileBasis` contains `blockNumber`, `blockHash`, `agentOwner`,
`agentUriDigest`, `registrationDigest`, `cardDigest`, and `receiptSigner` from
the independently checked owner-published profile. The service runtime's
`receiptSigner` must differ from `agentOwner`. Its only City permissions are
acceptance and completion for that service; it cannot update the ERC-8004
profile, spend funds, or sign as a caller.

`input` is `{ version: "0.1", capability: "evening-plan", city,
timeWindow: { start, end, timeZone }, area, budget: { currency: "USD",
minorUnits }, transport, preferences }`. `city` is Chicago or Boston. The
local start/end are full dates and times with explicit UTC offsets consistent
with the IANA zone (`America/Chicago` or `America/New_York`); the window is
positive and at most 24 hours. `area` is 1–120 UTF-8 bytes. `minorUnits` is an
integer number of cents encoded as a canonical unsigned decimal string from 0
through 10000000. `transport` contains 1–5 distinct values from `walk`,
`public-transit`, `bicycle`, `car`, `taxi`. `preferences` has at most 16 strings
of at most 256 UTF-8 bytes each. This structured input asks for a plan, not a
reservation or payment.

`interactionId` and `acceptanceId` are independently generated 32-byte random
hex identifiers. Addresses and hex values are lowercase-only in this City 0.1
wire format. `createdAt`, `acceptedAt`, `recordedAt`, and `deadline` are
real UTC seconds in `YYYY-MM-DDTHH:mm:ssZ` form. They are signer claims, not
independent evidence of when a statement existed. Expiry is evaluated with an
injected observation clock; claims dated later than that clock are reported as
future and cannot qualify the evidence at observation. A completed outcome
requires `answerDigest`; failed
and cancelled outcomes require their defined `reason`; expired has no answer or
reason. An incomplete or failed accepted interaction remains attributable.

## Bytes and signatures

The envelope is `{ version: "0.1", scheme: "eip712-eoa", signer,
payloadBase64, signature }`. The payload is the **original** UTF-8 byte string,
encoded in canonical padded Base64. Hash those bytes with Keccak-256; never
parse and reserialize them before hashing. Signature metadata is outside those
bytes. Requests are at most 16 KiB, acceptances/completions at most 4 KiB, and
answer bytes at most 256 KiB. Payload JSON is one compact object, with no BOM,
unknown fields, duplicate keys, alternative numeric spellings, or malformed
Unicode. The decoder requires the decoded text to equal
`JSON.stringify(JSON.parse(text))` before strict schema validation. This
restrictive City rule is not a general JSON canonicalization standard. Different
valid property order still means different signed bytes and a retry conflict.

The EIP-712 domain is `{ name: "NandaCityInteraction", version: "0.1",
chainId: service.agent.chainId }`. The selected primary type is `CityRequest`,
`CityAcceptance`, or `CityCompletion`, matching the decoded `kind`; each has
one `bytes32 payloadDigest` field. The ERC-8004 registry does **not** verify
these signatures, so it is not set as `verifyingContract`. Service/registry,
caller, interaction and profile are inside the committed request payload.
The verifier recovers the EOA and checks it against the caller for requests or
the profile's declared runtime signer for provider statements. A correct
signature on another purpose or a different payload is not reusable here.

Acceptance and completion are only meaningful with the exact verified parent
statements. The verifier must check the whole request → acceptance → completion
chain, not a detached completion digest. Retries key on qualified service,
qualified caller and interaction ID. Identical request bytes return the same
persisted task; changed bytes under that key conflict.

## Authority and timing

Signature validity, owner-published authority at a pinned chain block, current
authority, uninterrupted authority, deadline, and existence before a later key
retirement are separate findings. The provider must check an active profile and
live deadline before acceptance. An unfinished interaction cannot gain a new
completion under a changed owner/profile/signer. Checking two identical
snapshots is insufficient: the key could have changed away and back. The
continuity check needs canonical event coverage for the identity, or it remains
unknown and fails closed for new work. On a rotation failure, preserve the
signed acceptance and record an observer-side failure without fabricating a
provider-signed completion.

An old pinned block plus a signer-authored timestamp does not prove a later
receipt existed before key retirement. Without an independently accepted chain
publication or witness observation, that historical ordering is **unknown**.
Retained evidence is not erased by key rotation, but uncertain history must not
silently become qualified cross-epoch reputation. A local Anvil result proves
only what the selected local chain and fixture actually showed.

## Implemented A2A transport boundary

The first runtime slice uses A2A 0.3 JSON-RPC `message/send` with the signed
request in a data part, returns a `Task` with persisted signed acceptance, and
supports `tasks/get` polling. A completed task carries exact plan bytes and a
linked signed completion; an error after acceptance becomes a retained failed
task. A City
signature in a message body does **not** authenticate `tasks/get`. Local demo
polling is restricted to an owned loopback endpoint; a deployed service needs
explicit per-request HTTP authentication and authorization. The initial subset
is not advertised as full A2A conformance (for example, `tasks/cancel` is not
implemented). See [runtime details](a2a-loopback.md) and the
[A2A 0.3 specification](https://a2a-protocol.org/v0.3.0/specification/).
