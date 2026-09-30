# NANDA City in one minute

NANDA City demonstrates a network of specialist services that personal agents
can discover, use and review. Each service operator controls its identity and
profile. Shared evidence helps clients choose, while search Indexes remain
replaceable rather than becoming gatekeepers.

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
