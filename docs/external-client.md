# Separate Node client example

Run the local Chicago or Boston example with Node 24, Anvil, Docker and the
pinned clean NANDA Index checkout described in the [README](../README.md):

```sh
npm run demo:external-client -- --index-checkout /absolute/path/to/nanda-index-v2 --city Chicago
npm run demo:external-client -- --index-checkout /absolute/path/to/nanda-index-v2 --city Boston --json
```

The parent starts six synthetic services, two actual Index processes with
separate databases, an exact-card server and an ephemeral local registry. It
passes the child only public configuration: the two Index origins, separately
selected local RPC chain and registry with genesis hash and known implementation
address/code hash from the owned deployment, exact allowed card and service origins,
and city. No profile, candidate, response, signed request, fixture callback or
owner/runtime/caller key is passed. The child creates its own unfunded EOA key
in memory, never prints that key, and signs its own off-chain request.

For the selected city, the child requires three distinct candidates from each
Index and matching observations across the two. It checks the separately
configured chain and exact fetched AgentCard before it chooses. The default
choice is the lowest numeric agent ID among the three verified candidates;
this is stable demo ordering, **not** a reputation or quality ranking. It sends
a signed A2A 0.3 `message/send`, repeats the exact request once to check the
same task is returned, polls `tasks/get`, and verifies the signed acceptance,
completion and exact answer bytes. The parent then independently rereads live
chain authority and the card and verifies the child's exported evidence before
it tears down its owned fixture.

Origins are explicit `127.0.0.1` HTTP allowlists. The client refuses redirects,
unexpected service origins, malformed or overlarge A2A responses, and calls
that exceed its per-request or task deadline. The parent bounds the child
process's runtime and output. SIGINT/SIGTERM cancels the child and unwinds
parent-owned processes and containers through the shared cleanup scope.

This is a City-authored interoperability example on one host, not a stock
third-party agent or independent operator. Its providers, plans, prices and
sources are authored fixtures; no live city data, semantic quality, portable
feedback, reputation or production safety is established. The local chain and
Indexes stop at cleanup, so the JSON export is not a durable authority proof.
