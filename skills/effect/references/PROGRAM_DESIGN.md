# Effect Program Design

Use this reference when you define a public API, choose a module seam, or assign runtime ownership. A deep module gives callers a small domain interface and hides substantial policy, coordination, parsing, wiring, or lifecycle work.

## Design the public interface

A caller supplies domain values that it owns. The public interface hides credentials, provider clients, decoded storage records, layers, scopes, and runtime wiring. Required credential and provider capabilities stay in the internal Effect environment.

Use this deletion test. Delete the proposed module in thought. A useful module deletion spreads orchestration and invariants across its callers. A pass-through module deletion only removes forwarding code.

- Use a pure function for a domain decision with explicit value inputs and outputs.
- Use a service when a capability varies by runtime, implementation, or test seam.
- Use an adapter for an external SDK, protocol, filesystem, database, or host API.
- Use a facade or provisioner to lower public descriptors or configuration into internal services and layers.
- Do not add a wrapper only to mirror an SDK or data structure.

## Preserve Effect channels

| Concern | Channel or owner | Rule |
| --- | --- | --- |
| Success | `A` | Return the domain result. |
| Expected failure | `E` | Keep failures typed until a boundary can recover or narrow them truthfully. |
| Capability | `R` | Keep runtime-varying dependencies in the environment. |
| Resource lifetime | `Scope` | Acquire and release resources in the scope that owns their use. |
| Caller-owned domain input | Function parameter | Pass values that the caller already holds. |

Do not pass an error, service, layer, scope, or Effect as ordinary data only to compose it later. Do not put pure caller-owned values into services only to make all inputs ambient.

## Separate the pure core and I/O shell

Keep pure decisions, projections, and formatting separate from I/O coordination. Pure helpers accept and return domain values. Services and adapters run Effects and own external work.

Keep handlers thin. Decode the request. Read the required context. Call a domain service. Map the small public error set to the transport response.

## Own construction and resources

Build runtime-specific layer graphs at one composition boundary. A facade or provisioner can coordinate config, clients, adapters, memoization, scopes, and session-specific services. Callers must not rebuild this graph.

- Acquire external resources in the owning layer or scope.
- Register release at the same ownership boundary.
- Start background fibers with supervised or scoped forks.
- Bound concurrency for input sets that can grow without a fixed limit.
- Keep provider and network calls outside authoritative database transactions.
- Keep retry and shutdown policy with the module that owns the operation.

## Translate failures once

Wrap a throwing SDK or native API once with `Effect.try` or `Effect.tryPromise`. Map the unknown cause into the adapter's typed error vocabulary. Preserve the safe status, code, retry metadata, and cause information that a caller or operator needs.

Keep rich internal failures until the public module boundary. Narrow them there to the outcomes that callers can act on. Use a fallback only when the operation contract defines one.

Use `Effect.catchTag` or `Effect.catchTags` for expected failures. Use cause-level recovery only for a deliberate safety boundary that must also handle defects. Make an unexpected or swallowed failure observable before recovery.

## Add operation boundaries

Use `Effect.fn` or `Effect.withSpan` for meaningful public operations and I/O boundaries when observability is active. Add only safe context. Do not log secrets, credentials, or unrestricted provider payloads.

## Review checklist

- [ ] The public interface uses domain inputs and outputs.
- [ ] The module hides enough policy or coordination to justify its interface.
- [ ] Expected failures stay in `E`.
- [ ] Runtime capabilities stay in `R`.
- [ ] Every acquired resource and background fiber has one owner.
- [ ] Unknown data is decoded at its boundary.
- [ ] External failures are classified once at the adapter edge.
- [ ] Concurrency, retries, and shutdown are bounded and owned.
- [ ] Tests cross the public seam with real or layer-provided adapters.

See [SERVICES_LAYERS.md](SERVICES_LAYERS.md) for implementation patterns. See [TESTING.md](TESTING.md) for test seams.
