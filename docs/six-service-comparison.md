# Six-service local comparison

`npm run demo:compare -- --index-checkout /absolute/path/to/nanda-index-v2`
shows three synthetic evening-plan alternatives for Chicago and three for
Boston. Add `--json` to retain the original signed requests, acceptances,
completions, answer bytes, A2A Tasks, Index candidates, and recorded chain
observations. The checkout must be clean at the pinned public Index commit.
Node 24, Anvil 1.7.1, Docker on a local Unix socket, and the `postgres:16`
image are required. The command uses no paid, hosted, public-chain, personal
wallet, OpenClaw, or live city-data service.

The fixture starts six separate owner-published ERC-8004 identities, cards,
runtime signing keys, loopback A2A endpoints, and task stores. Three simulated
operators each publish a Chicago and a Boston service. Their plans differ in
food, culture, and travel/value emphasis and include dinner, activity, route,
example budget, source labels, and unmet constraints. These are authored
fictional concepts and example costs, not observed venues, event inventory,
prices, routes, accessibility, or plan quality. The operators share local code
and one hosting failure domain; they are **not** independent businesses.

Both actual local Indexes must expose the exact three services for each city.
Before invocation, City verifies each candidate against the selected local
chain, registry, and exact AgentCard. The caller makes six bounded signed A2A
requests, repeats one exact request to show that it returns the same task, and
makes a separate post-acceptance request that fails. The failed task is signed
evidence of a failure, not a seventh successful plan. Comparing every option
costs three service calls per city; there is no reputation policy, ranking, or
quality endorsement in this command.

While Anvil and the card server are still live, the fixture writes the original
seven evidence cases to a private temporary file and starts a **different Node
process**. It receives an explicitly supplied loopback RPC URL, exact card
origin, trusted chain ID, and registry address from the owned setup, not an
Index row. It re-runs `verifyJourneyEvidence` on each case, including canonical
block and current-authority reads and an exact card fetch. The batch check
requires six unique completed service IDs and task IDs, three city-bound
alternatives per city, three distinct owner keys, and a distinct failed task.
It rejects changed answer bytes in a second subprocess probe. A separate
process on the **same test host and local chain** is not independent real-world
custody or an Ethereum state proof.

The command tears down its owned chain, both Index processes and databases,
cards, endpoints, and temporary verifier files before returning. The JSON's
loopback origins are therefore historical, not live. Rechecking exported
observations later requires an independently available copy of the same chain;
the stopped ephemeral Anvil cannot be reconstructed from the JSON alone.
