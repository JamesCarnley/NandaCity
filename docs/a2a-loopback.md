# Owned loopback A2A task service

City implements a bounded A2A 0.3 JSON-RPC subset for local demonstrations. It
binds only to `127.0.0.1`, performs no external network calls, and implements
`message/send` and `tasks/get`. It does not claim full A2A conformance;
`tasks/cancel`, streaming, push notifications, and deployed transport security
are not implemented.

## Request and result

`message/send` accepts one A2A user `Message` with one `DataPart`:

```json
{
  "kind": "data",
  "data": {
    "type": "org.nandacity.city-request",
    "version": "0.1",
    "envelope": { "version": "0.1", "scheme": "eip712-eoa" }
  }
}
```

The abbreviated envelope above is illustrative. The runtime uses the complete
strict envelope and verifies its original request bytes cryptographically. The
JSON-RPC `id`, A2A `messageId`, generated Task `id`, and signed City
`interactionId` are distinct values.

The service returns a real A2A `Task`. City metadata contains the signed
acceptance and states `pollingAuthentication: "none-loopback-only"`. A completed
Task artifact carries canonical padded Base64 of the exact answer bytes and the
linked signed completion. The authored default answer is synthetic fixture data;
it explicitly says that live hours, events, bookings and travel times were not
checked.

The implemented send path is non-blocking: omitted or `false` `blocking`
returns the persisted submitted Task and execution continues locally.
`blocking: true` and send-time history shaping are explicitly rejected as
unsupported rather than silently ignored.

`tasks/get` returns the persisted Task and supports `historyLength`. Polling is
not authenticated. Binding to loopback limits exposure for this demo, but it is
not an authorization design. Any nonlocal deployment needs per-request HTTP
authentication and authorization as required by A2A.

## Authority and durability

The caller cannot supply the authority result. The service receives an async
authority probe receiving the decoded signed request that independently supplies the pinned verified profile, current
verified profile, explicit continuity finding, and observation time. It probes
before acceptance, immediately before beginning accepted work, and again before
terminal signing. Every claimed acceptance or terminal time must be covered by
an observation at or after that time. Missing, stale, unknown or changed
authority fails closed. A separate owner-published runtime key signs acceptance
and completion; the owner key is never passed to the service.

The owned chain adapter first rejects requests for a different fixed service,
then rebuilds the exact signed block's profile using retained card bytes and
checks the signed block hash. It reads current authority separately and uses the
[bounded reference-registry continuity reader](authority-continuity.md). A
startup profile cannot substitute for a caller's newer basis after feedback
publication or other unrelated blocks.

The unique key is qualified service + caller + interaction ID. Before returning
or executing work, the service atomically persists the signed acceptance and
submitted Task. Exact concurrent replay returns the same Task and does not run
the executor twice. Different signed request bytes under the same key conflict.
Reopening the store after service restart preserves the same Task.

Execution failure retains the acceptance and a failed Task. With unchanged
authority it also signs a truthful failed completion. A result recorded after
the request deadline can receive an expired completion only when a fresh
independent observation still proves the same authority and is not earlier than
the recorded time. Changed or unknown authority preserves acceptance but cannot
produce a new provider completion.

Execution has a configurable local timeout (five seconds by default, bounded to
one minute). The executor receives an `AbortSignal`; cooperative executors can
stop promptly, while an executor that ignores cancellation is detached after the
timeout and cannot write a late result. A timeout is retained as an execution
failure only after authority is rechecked. Authority observation, verification,
signing and store failures are never relabeled as provider execution failures.
Closing the service does not wait for a detached executor that ignored
cancellation. The injected authority probe must enforce its own I/O timeout;
this local service does not bound an arbitrary probe implementation.

The store is intentionally a single-process local fixture. Its in-process key
lock is sufficient for concurrent calls to one owned service; it is not a
multi-process database or production queue.
