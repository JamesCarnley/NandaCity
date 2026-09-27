# Bounded source-backed evening proposals

This is a locally tested, programmatic capability, not a deployed service or a
completed live rehearsal. Tests use owned loopback HTTP servers, fictional source
payloads, fake prices, generated signing keys and explicitly injected test
generation. They establish local boundaries, not real API readiness, permissions,
venue opening hours, operator independence or semantic quality.

Ethereum remains the default authority strategy. Explicit HTTPS-origin operation
uses its separate signed decoder and authority strategy; there is no automatic
fallback. Neither strategy's completion signature proves the plan is useful.

## Configuration and ownership

`LiveAnswerBackend` shares one `LiveBudget`, `LiveAdapters` and injected inference
configuration across Chicago/Boston × food/culture/travel-value. `forScope` produces
an executor for the existing runtime; scope does not select URLs, credentials,
identity authority, account budgets or signing keys. Services still own their
separate exact cards/profiles, receipt signers and task identities.
The executor carries immutable source retention metadata. Runtime retention must
use the same policy ID and an expiry no later than that source ceiling; a shorter
runtime expiry is permitted. A live callback without that binding is rejected.
Conversely, a source-bound executor without explicit `live.caller` admission is
rejected before task storage opens. Unbound authored-fixture callbacks remain
available for fixture operation.

Live runtime options require `live.caller`, unexpired licensed retention and an
explicit executor. Admission compares the configured caller's exact method,
address and, for Ethereum callers, chain ID before acceptance. Signature and
current authority checks remain separate and unchanged. `tasks/get` polling is
still unauthenticated on an owned loopback service: this is **not hosted access
control**. Live execution defaults to the existing 60-second maximum; explicitly
selected live polling is capped at 65 seconds, including a 5-second response
margin. Fixture execution/polling defaults remain unchanged.
An unfinished legacy fixture task cannot resume through a live/source-bound
executor: it becomes unsigned `interrupted-unresolved`, keeping the original
acceptance and record version, with no source dispatch or invented completion.
Fixture-to-fixture restart remains supported.

The existing configured Ethereum client accepts a programmatic `live` input and
caller signer. The signer must match service admission. The CLI intentionally has
no live private-key/configuration field. Existing discovery still expects the
owned two-Index, three-candidate-per-city scope; this is not arbitrary external
service discovery or a human-facing live UI.

Production transport requires explicit enablement and configured credentials. It
uses only these three fixed endpoints, refuses redirects and never follows
returned images, pagination, resource links or model-selected URLs:

- Google Maps Grounding Lite MCP: `https://mapstools.googleapis.com/mcp`.
- Google Routes transit: `https://routes.googleapis.com/directions/v2:computeRoutes`.
- Ticketmaster Discovery: `https://app.ticketmaster.com/discovery/v2/events.json`.

An endpoint override exists only in explicit `local-test` mode, limited to
`http://127.0.0.1`. Source display links use a fixed HTTPS host allowlist:
`maps.google.com`, `www.google.com`, `maps.app.goo.gl`, `www.ticketmaster.com`,
`www.transitchicago.com`, `www.mbta.com`. Unknown/unsafe hosts are rejected, not
fetched. Additional real agency hosts require a reviewed configuration change.

## Source and generation boundary

The fixed MCP sequence is initialize, initialized notification, one tools/list and
one search_places. The client accepts the explicit `2025-06-18` profile and the
two known snake/camel argument schemas only. Bounded JSON and POST SSE are
supported; unsupported negotiation, additional schema constraints, wrong IDs,
tool errors and conflicting result representations fail closed. Assigned sessions
receive a metered DELETE; 405 is labelled unsupported cleanup. Failed sessions
are never silently reopened.

Only the complete Grounding Lite bundle enters the injected generator. Its
grounded block must exactly preserve the source summary and ordered place
citations. Returned place IDs must be actual bundle members. Ticketmaster events
and Routes transit are separately attributed deterministic panels and never
generation context. Caller/signing identities, credentials and upstream errors
are not generation inputs. No model or provider implementation is included.

Production inference additionally requires an explicitly approved grounding/model
policy ID matching the retention policy; a short TTL alone is not permission.
The trusted inference injection must perform exactly one physical inference
dispatch, with no internal retries or extra tools, and implement provider-specific
token accounting over its entire request, including wrappers. Character estimates
are not exact token counts. Admission and reported usage must both fit 8,000 input
and the configured maximum of at most 2,000 output tokens. A generator that ignores
abort retains its account concurrency slot until its underlying work settles.
The run deadline is also capped by source expiry, and generation checks that
expiry again at its actual dispatch boundary after any slot/reservation wait.

The answer is always labelled a proposal with gaps. Dinner time is an
application-authored one-hour allocation (clipped to a shorter requested window),
and the Maps hours query uses that same clipped interval. It is not source
evidence of hours. Source prose never proves a venue open or affordable.
Missing dinner cost, event end/price or transit fare stays unknown; unknown fare
is not zero. Event local/UTC dates, timezone, status and city, plus route step
chronology, are validated. Unavailable transport, late arrival, known budget
overrun, incomplete event coverage and unverified preferences remain explicit.
No booking, payment, identity write or automatic fixture fallback occurs.

## Budget and interruption

The account ledger enforces two concurrent physical calls across services and at
most two Ticketmaster calls per second. Each run has a 60-second deadline;
source/protocol calls get at most 10 seconds and inference at most 20, always
bounded by remaining time. Each decoded HTTP response, including SSE and errors,
is capped at 1 MiB, with 4 MiB aggregate per run. Answers additionally fit the
existing 256 KiB runtime bound.
Ticketmaster rate slots are recorded at physical callback dispatch, after the
durable reservation, so delayed persistence cannot age out an undispatched call.

Ten total physical attempts cover the cold MCP sequence (four), events, transit,
inference, DELETE, one global explicit transient retry and one cancellation
notification. All attempts durably reserve conservative cost before dispatch.
One bounded jittered retry is allowed only after an explicit 502/503/504 response;
auth/quota/schema errors, ambiguous disconnect/timeouts and inference never retry.
Notifications and cleanup do not have hidden retries.

Admission durably holds ten times the largest configured per-attempt price to
protect run/session and cleanup headroom. Finishing a run durably releases unused
headroom, not consumed reservations. Interrupted runs retain their admission hold;
their task IDs cannot be resumed or reissued. Current prices, expiry and explicit
run/session caps are required even for protocol messages: unknown prices are not
assumed free. This is conservative local accounting, not an invoice guarantee.

The directory has one exclusive writer lock, including across processes. Stale
lock removal and interrupted-run reconciliation require explicit operator action;
there is no automatic takeover or refund. Keep the same ledger directory/session
for service comparisons. Do not create a fresh ledger to bypass its allowance.
The strict bounded journal stores only task/purpose IDs, monetary amounts,
reservation state and sanitized outcomes, never source content, credentials, URLs
or upstream exception text.
Closing immediately stops new admission. If physical work is still active, close
fails while preserving the writer lock; after it settles, retry close to release
the lock. Concurrent close calls share cleanup and a completed close is harmless.
Lock release is serialized with journal writes. Once release starts, old handles
cannot settle or finalize runs; unfinished durable holds remain conservative,
including when a replacement writer reopens the directory. Finish normal runs
before closing when their unused hold should be released.

Cancellation aborts local requests and, when session/deadline/headroom permit,
sends one metered pending-request cancellation followed by DELETE. A remote
cancellation that cannot be confirmed is labelled unconfirmed; exhaustion never
opens an unmetered cleanup channel.
Failed composed runs persist `runs[].diagnostic` in `budget.json`, containing
only the sanitized original `failureReason` and `cleanup` finding (including
`remote-cancellation-unconfirmed` when deadline exhaustion prevents dispatch).
This is a local operational diagnostic, not signed receipt evidence. The original
execution error is still raised; diagnostic persistence adds no HTTP attempt or
deadline extension. Old journals without diagnostics remain readable.

## Display, retention and remaining live gates

`liveAnswerSchema` describes the exact transient JSON answer. A permitted local
display must show the intact `grounding.block`, then its associated Maps link
previews immediately (accessible in one interaction), followed by separate
provider-synthesis/event/transit panels and gaps. Escape all text/attributes;
never render upstream HTML. This increment does not add a renderer or UI.

Runtime answer bytes use the existing expiring `TransientByteHolder`; durable
tasks, configured caller evidence, stdout and HTML/JSON exports remain receipt
only. Expiry/restart does not change the original signed completion or answer
digest and never regenerates work. Semantic replay becomes unavailable. The
configured caller requires a valid licensed runtime policy with the same policy
ID before taking byte ownership, then uses the earlier local/runtime expiry for
its holder, verification and availability exports. Missing, incompatible or
full-export response policy cannot grant permission. The
current configured caller exposes availability findings, not a retained display
copy; a future local session UI needs a separately reviewed transient display
seam with the same expiry ownership, not an exported answer field. Raw provider
responses exist only during bounded in-process calls; neither the journal nor
the answer artifact is a licensed-source archive.

Before any real rehearsal, an owner must choose inference provider/model/account,
approve compatible source/model handling, obtain credentials and authorize actual
spend/run/session caps. Engineering must verify negotiated MCP protocol/schema/
result wrapping, exact pricing/SKUs and quotas, provider retention/training/cache
settings, permitted source expiry and attribution, and dated Chicago/Boston
coverage. These remain unverified. Local authored fixtures do not resolve them.
