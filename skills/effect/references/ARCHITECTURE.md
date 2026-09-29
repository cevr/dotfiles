# Effect Application Architecture

Use this reference to lay out an application: its packages, its public actions, the surfaces that expose them, the units that own infrastructure, and the rules that keep the layout from eroding. [PROGRAM_DESIGN.md](PROGRAM_DESIGN.md) covers a single module's seam; this file covers how modules fit together.

The reference implementation is `joelhooks/rat-stack` (`okra repo fetch joelhooks/rat-stack`). Read `packages/capability/src` there before building a contract kit, and adopt its code only after reading it at the pinned Effect version.

## Contents

- One contract, every surface
- Composition root
- Nouns and dependency direction
- Cartridges
- Clients
- Lifecycles
- Braids to look for
- Fence the layout

## One contract, every surface

A **capability** is one public action. It has one contract and one handler. Every surface (CLI command, HTTP route, MCP tool, browser RPC) is a **projection** derived from the contract. A projection never contains domain logic.

The contract holds:

| Field | Rule |
| --- | --- |
| `name` | Stable. Becomes the command, route, tool, and RPC name. |
| `input` | `Schema.Struct`. Encodes and decodes without services. |
| `output` | Schema. |
| `failure` | Schema of the expected tagged errors. |
| `annotations` | Honest `readOnly`, `idempotent`, `destructive`, `openWorld`. MCP clients and retry policy read them. |
| `needsApproval` | Adds an approval requirement to `R` and an approval-denied failure to `E` for every projection. Policy stays out of the handler. |

```ts
export const inspectFileContract = defineContract("inspectFile", {
  annotations: { idempotent: true, readOnly: true },
  description: "Count bytes, words, and lines in a file",
  failure: FileStatsError,
  input: Schema.Struct({ path: Schema.String }),
  output: FileStats,
})

export const inspectFile = implement(inspectFileContract, ({ path }) =>
  FileInspector.use((inspector) => inspector.inspect(path))
)
```

| Projection | Effect module | Derived artifact |
| --- | --- | --- |
| CLI | `effect/unstable/cli` (`Command`, `Flag`, `Argument`) | Flags from input fields, `--json` from output |
| HTTP | `effect/unstable/httpapi` | Endpoints and `OpenApi.fromApi` document |
| MCP | `effect/unstable/ai` (`Tool`, `Toolkit`, `McpServer`) | Tool JSON Schema and annotations |
| Browser | `effect/unstable/rpc` | `RpcGroup` built from contracts alone |

Rules:

- JSON Schema, OpenAPI, and tool declarations are derived from the contract schemas. Nothing is written by hand.
- Contracts live in a module with no server dependencies, so browser code can import them.
- The handler stays small. Real work lives in a service or a lifecycle machine.
- Only the projection package calls `HttpApiEndpoint`, `Rpc.make`, `RpcGroup.make`, `Tool.make`, or `Toolkit.make`. Everything else projects contracts.
- Keep only the surfaces the product uses. A surface is cut by deleting its projection file and its composition-root line.

A single-surface app does not need a contract kit. Write the `HttpApi` or `Command` directly, and introduce contracts when a second surface appears.

## Composition root

One module per app instantiates projections, and one module provides the layer graph. Domain code never calls `Layer.provide` for its own dependencies; requirements bubble to the root. The root is also the only place that chooses a runtime (`BunRuntime.runMain`, a Worker `fetch`, a CLI `run`).

## Nouns and dependency direction

Name the pieces and give each one a home. Record the table in the repo's `AGENTS.md`:

| Noun | Home | Job |
| --- | --- | --- |
| Contract | `packages/core/src/contracts.ts` | Name, schemas, failure, annotations |
| Capability | beside its service or data | Binds one contract to its handler |
| Projection | `packages/capability/src/to-<surface>.ts` | Exposes capabilities on one surface |
| Service | `packages/<domain>/src/<name>.ts` | `Context.Service` plus `layer` |
| Cartridge | `packages/<name>/` | Service tag plus vendor layers that own their infrastructure |
| Machine | `packages/<domain>/src/<name>-machine.ts` | One finite lifecycle |
| Feature | `apps/web/src/features/<name>/` | Thin route and view |
| Client | `apps/web/src/client/<name>.ts` | Transport, replica, named commands |

Dependencies point one way: `apps/*` → domain packages → contract kit → `effect`. Packages never import apps. The contract kit never imports domain code. Browser modules import contracts, never handlers. Enforce each arrow with a lint rule (see Fence the layout).

For package manifests, workspaces, and turbo wiring, load the `project-scaffolding` skill.

## Cartridges

A **cartridge** is a replaceable unit that owns infrastructure: a service tag plus one layer per vendor. With Alchemy, the vendor layer declares its own cloud resources, so providing it provisions them.

- The service tag is the product API.
- A layer is one vendor's implementation, carrying its resources and bindings.
- `Layer.provide` is the vendor's private supply chain. Swapping vendors changes one line.
- Typed errors are the contract callers rely on.

Cartridge test, run concretely:

1. Delete the package and its one `Layer.provide` or Stack line. The gate still passes, or its errors name every place that reached inside.
2. Nothing outside the cartridge imports its internals, schemas, or SQL dialect.
3. It could be rewritten from its schemas and tests.

Load the `alchemy` skill for resource and binding APIs.

## Clients

The server is authoritative. A client holds a replica and reconciles; it never decides.

One call follows one path: feature → named client command → RPC → capability → authoritative host (database cartridge or Durable Object). Features read state and call named commands. Clients own transport, retries, and the replica. Mutations name the keys they invalidate so the replica reconciles.

For component patterns, load the `react` skill.

## Lifecycles

When work has modes with different legal events (retrying, cancelled, resumable, awaiting approval), model it as a state machine instead of status strings and booleans. The machine owns states and transitions. Effect owns side effects, typed errors, services, and cleanup: side effects are declared Effect actors, never Effects returned from inline callbacks. Run the machine inside a scope so interruption stops it.

Keep a plain `Effect.gen` workflow when the work has no states that matter.

## Braids to look for

Use this table when reviewing or redesigning a layout. Each row is a concern that should live in one place.

| Braid | Where it belongs |
| --- | --- |
| Domain logic inside an HTTP handler, CLI command, MCP tool, or RPC handler | The capability handler or its service |
| Transport inside a feature (`fetch`, client construction, retry) | The client module |
| Vendor SDK, SQL, or ORM queries outside the cartridge | The vendor layer behind the service tag |
| Infrastructure declared away from the layer that uses it | The cartridge's own layer |
| Approval, rate limit, or retry written into a handler | Contract annotations, `needsApproval`, or the boundary service |
| Status strings and booleans encoding modes | A lifecycle machine |
| A cache or replica that makes decisions | The authoritative host |
| Two ways to do one thing | One paved path; delete the other |

For each proposed new piece, name what it deletes. A tag, layer, or state that deletes nothing is ceremony.

## Fence the layout

Agents copy what they find, so a boundary that lives only in prose erodes. Put each rule on the highest rung that can hold it:

1. **Code.** A type or API that makes the wrong version unwritable: a schema at the boundary, a required service, a contract kit that projects surfaces.
2. **Static analysis.** An import-boundary or pattern rule in oxlint, with a fixture test that fails when the rule is broken.
3. **Repo law.** A line in `AGENTS.md`, only when neither rung above can hold it.

When a bad pattern appears, write the rule that fails on it first, then fix every instance so the rule starts at zero findings. When some findings must stay, record them in a baseline that only shrinks. `project-scaffolding` covers the lint wiring.
