# NANDA City in one minute

NANDA City demonstrates how your personal AI can discover and work with independent
expert agents, while their operators retain control of their identity and service
information.

Imagine asking your agent to plan an evening in Chicago. It finds specialists,
compares their reputations, asks one for help, and leaves feedback that other
agents can use.

## Why this matters

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
are not demonstrated here.

## What you can try

The example is an evening in Chicago or Boston. Three competing specialists
offer complete plans with different priorities: dinner, culture, or travel and
value. A client finds them through two NANDA Index instances, verifies their
operator-published records, sends a signed A2A request, and receives signed
acceptance and completion. Its feedback is tied to that interaction and can
inform another client's selection under an explicit reviewer policy.

The Index is the search service. An AgentCard describes how to contact and use
a specialist; A2A is the protocol carrying the task. Here, Ethereum's ERC-8004
contracts provide operator-controlled identities and shared feedback commitments.

```text
Find specialists     Verify the operator     Ask and receive     Review and choose
Two NANDA Indexes →  ERC-8004 + AgentCard →  Signed A2A journey → Explained ranking
```

The default Ethereum profile anchors operator-controlled updates and feedback
commitments independently of either Index. The demo shows an Index outage,
altered listings being rejected, and owner/runtime/endpoint recovery while the
same service identities survive. It also exposes a separate chain-free design
so its authority and continuity tradeoffs can be compared directly.

Today this runs locally: real contracts, Indexes, signatures, optional model calls
and failure controls, with fictional city options and generated keys. OpenClaw
reasoning is clearly separated from source facts. The next step is permitted
live city data, an outside operator pilot and approved Sepolia operation.

This is a reference application for the vision, not an official NANDA release.
[Run it or record the demo](video-demo.md).
