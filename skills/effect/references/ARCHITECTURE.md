# Effect Application Architecture

Use this reference to lay out an application: its packages, its public actions, the surfaces that expose them, the units that own infrastructure, and the rules that keep the layout from eroding. [PROGRAM_DESIGN.md](PROGRAM_DESIGN.md) covers a single module's seam; this file covers how modules fit together.

## Contents

- Pick the contract source
- One contract, every surface
- Shape operations for the client's outcome
- Composition root
- Nouns and dependency direction
- Cartridges
- Clients
- Packages
- Lifecycles
- Build one vertical slice
- Braids to look for
- Fence the layout

## Pick the contract source

Every public action has one contract, and every surface is derived from it. Where that contract comes from is the first decision, because it decides most of the layout below.

| The app | Contract source |
| --- | --- |
| A backend whose job is business rules over recorded facts (requests a state owner accepts or refuses, reads shaped for screens), hosted on Cloudflare with Alchemy | The **Domain Api** of an `@alchemy.run/domain` model. Load the `alchemy` skill's `references/domain.md`: it settles the fit and routes to the upstream `alchemy-domain` skill for building the model. |
| The same kind of backend, kept off Alchemy (its own hosting, such as Mongo and queues in a work monorepo) | **The Domain shape on your own `Platform`.** At runtime `@alchemy.run/domain` imports only two Effect-only modules from `alchemy` and nothing from Cloudflare, and its `Platform` service is the hosting seam. Depend on the package and write a `Platform` for your stores; this is also the first step when Alchemy will later replace the project's infrastructure tool, because the `alchemy` peer is then the deploy tool you are adopting. When Alchemy is not the direction, vendor its core (Apache-2.0) into a package you own and replace those two imports, so the beta `alchemy` peer stays out and Effect upgrades stay on your schedule. Either way keep the API identical to upstream, so the rest of this file's Domain path applies unchanged. |
| A library; a CLI or tool over local files or a vendor API; request/response work with no state of its own; a backend on Railway or another container host; a product that needs approval before a write, its own tool annotations, or tool lists filtered per caller | **Hand-built contracts**, the rest of this file. Its reference implementation is `joelhooks/rat-stack` (`okra repo fetch joelhooks/rat-stack`, or `git clone --depth 1 https://github.com/joelhooks/rat-stack` without okra): read `packages/capability/src` before building a contract kit, and adopt its code only after reading it at the pinned Effect version. |

One app can hold both: a Domain backend, plus hand-built contracts for local work a CLI does beside it.

The two paths share one architecture: an infrastructure-free core package, surfaces derived from one contract and never written by hand, a host that is the composition root and owns infrastructure, typed failures that reach the client, and import boundaries fenced in lint. On the Domain path `@alchemy.run/domain` is the kit; on the hand-built path you write it. The sections below are written for the hand-built path, and each says what changes on the Domain path where it differs. The vocabulary maps one to one:

| Hand-built | Domain path |
| --- | --- |
| Contract and capability | A command, which its aggregate decides, or a read (a view, a stream, or an aggregate with `read`), listed on a `Domain.Api` |
| Projection | `yield* MyApi` and `MyApi.client` (Effect RPC), `toHttpApi`, `toCli`, `toToolkit` and `toMcp`, the foldkit adapter |
| Contract kit | `@alchemy.run/domain` |
| `annotations` | Fixed: reads are read-only and idempotent, commands destructive |
| `needsApproval` | No equivalent at beta.85; a command's middleware can demand a second factor |
| Composition root | The `server` package's Worker Layer |
| Cartridge | A port or external system declared in the `domain` package, with its vendor Layer in `server` |
| Machine | An aggregate for one instance's states, a saga for a process across aggregates |
| Client SDK | `MyApi.layerClient` over a protocol |
| Tests through public Effect interfaces | Stories for the model, an Api test per access rule, one deploy test ([TESTING.md](TESTING.md) §Domain models and deployed stacks) |

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
| `needsApproval` | Adds an approval requirement to `R` and an approval-denied failure to `E` for every projection. Policy stays out of the handler. The CLI approves on `--yes` or an opt-in confirmation prompt, and denies without either. |

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
| CLI | `effect/cli` (`Command`, `Flag`, `Argument`) | Flags from input fields, `--json` from output |
| HTTP | `effect/http-api` | Endpoints and `OpenApi.fromApi` document |
| MCP | `effect/ai` (`Tool`, `Toolkit`, `McpServer`) | Tool JSON Schema and annotations |
| Browser | `effect/rpc` | `RpcGroup` built from contracts alone |

Rules:

- JSON Schema, OpenAPI, and tool declarations are derived from the contract schemas. Nothing is written by hand.
- The HTTP projection answers each failure member with its own `httpApiStatus` annotation (422 when it has none) and declares the 400 for a body that does not decode, so the OpenAPI document lists every response a client can get.
- Contracts live in a module with no server dependencies, so browser code can import them.
- The handler stays small. Real work lives in a service or a lifecycle machine.
- Only the projection package calls `HttpApiEndpoint`, `Rpc.make`, `RpcGroup.make`, `Tool.make`, or `Toolkit.make`. Everything else projects contracts.
- Keep only the surfaces the product uses. A surface is cut by deleting its projection file and its composition-root line.

A single-surface app does not need a contract kit. Write the `HttpApi` or `Command` directly, and introduce contracts when a second surface appears.

The API is complete when a team in another language (a Swift app, a CLI, an MCP server) could rebuild the product from the documented operations and protocols alone, without the TypeScript client or app source. Domain rules, authorization, state transitions, and orchestration sit behind operations.

On the Domain path, the Api lists entries and the package projects them, so none of the rules above is written by hand. A narrower surface is a smaller Api (one per kind of client), and an HTTP status is an `httpApiStatus` annotation on the rejection, with the same 422 default. The surfaces and their limits are in the `alchemy` skill's `references/domain.md`.

## Shape operations for the client's outcome

Logic that can run on the server runs there. Design each operation around what the client needs to show or do next, so the client makes one call:

```ts
// The client waits on one result to make the next call: a waterfall.
const user = yield* client.users.current()
const teams = yield* client.teams.forUser({ userId: user.id })

// One call: the server joins the user to their teams.
const { user, teams } = yield* client.users.currentWithTeams()
```

- A waterfall moved into a client library is still a waterfall. The client makes the same round trips and the server's decision still lives in the client.
- A command creates its own prerequisites (the workspace, the session) on the server. The client never runs an open, then status, then start chain.
- Dependent writes for one outcome are one operation, with stated transaction or partial-failure behavior.
- Queries are safe reads: a retry, a refetch on focus, or a second observer never starts work or changes state. A command is a mutation even when it is idempotent.
- On the Domain path, the outcome-shaped read is a view keyed by what it is about, and a command's prerequisites come from a policy or saga on the server.
- Compose operations instead of passing a mode: `terminals.attach({ sessionId })` and `computers.attach({ sessionId })`, not `surface({ kind, sessionId })` that branches inside. Each operation composes the shared authorization and connection parts. This holds for services, client helpers, hooks, and components. IDs, limits, and abort signals are ordinary parameters, and a discriminant in a returned state describes data, not a mode.

## Composition root

One module per app instantiates projections, and one module provides the layer graph. Domain code never calls `Layer.provide` for its own dependencies; requirements bubble to the root. The root is also the only place that chooses a runtime (`BunRuntime.runMain`, a Worker `fetch`, a CLI `run`).

On the Domain path, the `server` package's Worker is the root: it builds one Layer from the platform, `Model.layer(handlers)`, the middleware implementations, and the adapters, and serves each surface from it. Swapping the platform Layer (`Domain.InMemory` or Durable Objects) moves the model between a test and production without touching it.

## Nouns and dependency direction

Name the pieces and give each one a home. Record the table in the repo's `AGENTS.md`:

| Noun | Home | Job |
| --- | --- | --- |
| Contract | `packages/<domain>/src/<feature>/contract.ts`, beside its service | Name, schemas, failure, annotations; no server imports |
| Capability | beside its service or data | Binds one contract to its handler |
| Projection | `packages/capability/src/to-<surface>.ts` | Exposes capabilities on one surface |
| Service | `packages/<domain>/src/<name>.ts` | `Context.Service` plus `layer` |
| Cartridge | `packages/<name>/` | Service tag plus vendor layers that own their infrastructure |
| Machine | `packages/<domain>/src/<name>-machine.ts` | One finite lifecycle |
| Feature | `apps/web/src/features/<name>/` | Thin route and view |
| Client | `apps/web/src/client/<name>.ts` | Transport, replica, named commands |

Organize by feature first, then by role inside the feature. A global `contracts`, `schemas`, `types`, `services`, or `hooks` folder splits each feature across the tree, so do not create one. The contract kit holds `defineContract` and the projections; each feature owns its contracts.

Dependencies point one way: `apps/*` → domain packages → contract kit → `effect`. Packages never import apps. The contract kit never imports domain code. Browser modules import contracts, never handlers. Enforce each arrow with a lint rule (see Fence the layout).

On the Domain path, the upstream layout replaces this table: one `<Noun>.<kind>.ts` file per building block in a `domain` package, folders per subdomain, and hosting and adapters in a `server` package. Dependencies still point one way: `web` and `server` → `domain` → `@alchemy.run/domain` and `effect`.

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

On the Domain path, the service tag is a port (`Context.Service` with a memory implementation) or an external-system declaration in the `domain` package, and each vendor Layer lives in `server`. The cartridge test holds unchanged.

## Clients

The server is authoritative. A client holds a replica and reconciles; it never decides.

One call follows one path: feature → named client command → RPC → capability → authoritative host (database cartridge or Durable Object). Features read state and call named commands. Clients own transport, retries, and the replica. Mutations name the keys they invalidate so the replica reconciles.

The client SDK is one root `createClient()` that exposes the whole product, with its methods, query keys, and options inferred from the RPC group. Write no hand-kept mirror of the operations. Each handwritten addition passes an admission test:

1. Can the owning operation return the result or run the workflow? Put it there.
2. Does the inferred operation, the query library, the transport, or a host adapter already own the behavior? Reuse that owner.
3. Otherwise the addition owns work that must run on the client (assembling a stream, cancelling a local attachment, reading a documented connection protocol). Name its consumer, the state only it owns, and why it cannot run on the server.

Failures reach the screen typed. Each declared failure has a stable, unique tag and a schema payload with no `name` field (it replaces the error's own name in logs and `String(error)`); a payload that offers recovery (switch to the right team) carries only what the server authorized the caller to see. The SDK turns transport, decode, and unexpected failures into its own tagged variants, so a consumer handles one closed union and never parses a message.

Prove the SDK with a non-React consumer that runs the slice's lifecycle (including recovery and cancellation, where the product has them) through public exports alone. Calling raw endpoints proves the transport, not the SDK.

Where tools execute is a separate choice from where the client runs. A mobile client, a CLI on the cloud API, and a CLI with an in-process API are different composition roots of the same contracts. The host authorizes and provides the execution capability; shared code never checks `isLocal` or `window` to decide where a command runs.

On the Domain path, the inferred client is the Api's (`MyApi.client`, `MyApi.layerClient`), and `MyApi.rejections` is one schema of every rejection its commands declare, so a screen holds a refusal as typed data. The admission test still governs every handwritten addition.

For component patterns and server state in React, load the `react` skill.

## Packages

Build every package as if it were published, whether or not it is:

- It declares its dependencies, files, runtime, and exports. Pack it and import it from an isolated consumer through public exports only; a workspace alias must not hide a missing dependency or a broken declaration path.
- Its root entry is vanilla: no React, Next, or platform imports. Framework adapters live in explicit subpath exports (`client-sdk/react`, `api/next`, `api/bun`), with the framework as an optional peer, so importing the root works without it.
- Each consumed entry point is one barrel that re-exports implementation files directly. Do not chain folder barrels into feature barrels into a package barrel. Inside the package, import implementation files through private aliases; no `./*` export reaches private files.
- Apps and features import vendors through an owned entry point that names what the product uses. A wildcard re-export of a vendor is not ownership. When the vendor's root is a barrel, the owned entry re-exports from its granular paths; measure the bundle.
- App bootstrap (root layout, global providers, client lifetimes, host configuration) belongs to the app, not to a feature named `app`.

## Lifecycles

When work has modes with different legal events (retrying, cancelled, resumable, awaiting approval), model it as a state machine instead of status strings and booleans. The machine owns states and transitions. Effect owns side effects, typed errors, services, and cleanup: side effects are declared Effect actors, never Effects returned from inline callbacks. Run the machine inside a scope so interruption stops it.

Keep a plain `Effect.gen` workflow when the work has no states that matter.

On the Domain path, an aggregate is the machine for one instance: its state, `decide` for which commands are legal, `evolve` for the transitions. A saga carries a process with steps, waits, and compensation across aggregates.

## Build one vertical slice

Design from the consumer inward, build from the core outward, and verify through the user's interaction. Before code, write the SDK call and the component tree the outcome needs, with its failure and recovery states, and mark each layer below as reuse, change, or not applicable. Then build in this order; each stage hands its evidence to the next:

| Stage | Evidence before the next stage depends on it |
| --- | --- |
| 1. Contract: input, output, failure, and event schemas; authorization, cancellation, and replay rules | Valid and invalid inputs and every legal outcome are written down |
| 2. Service, plus persistence and adapters only where needed | Success, denial, validation, and failure run against explicit real or test layers |
| 3. Handler bound and mounted in the composed API | A caller through the API reaches the real service and gets the declared failures |
| 4. Inferred RPC and SDK additions that pass the admission test | A non-React consumer runs the lifecycle through public exports |
| 5. React data boundary: derived query options, the mutation policy, subscription adapters | Public React consumers compile and run the cache or subscription behavior |
| 6. Feature hooks, providers, and state presentations | Components work through the contract with no effects or raw transport |
| 7. App mounts the feature and injects host choices | The real interaction travels the mounted path and updates the screen, failure path included |

A greenfield product builds only the shared foundation its first slice needs, then finishes that slice before the next one. A narrower change starts at the lowest owner whose contract changes. A failed check goes back to the stage that owns it; downstream code never compensates with a copied schema, a cast, a manual fetch, or an alternate client method.

On the Domain path, stages 1 to 3 follow the upstream skill's checklist for a change: the command with its events and rejections, the aggregate's `decide` and `evolve` branches, the views, policies and projections that care, the Api entry, and a story for every outcome. Stage 3's evidence is an Api test over `Domain.InMemory` with the real middleware. Stages 4 to 7 hold as written, with the Api's client as the inferred client.

Report architecture evidence (lint profile, public-consumer checks, a second client's lifecycle) apart from functional evidence (the user flow). A working demo or a green compiler does not pass an architecture requirement nobody tested, and a mocked screen or a working endpoint is not a finished feature.

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
| A client chain of dependent reads or prerequisite writes | One operation shaped for the outcome |
| A mode argument that selects a code path | Explicit operations that compose shared parts |
| SDK code making a decision the server could make | The owning operation |
| A check for local, sandbox, or `window` that picks where a command runs | An execution capability the host provides |
| A business rule in a route, CLI command, tool handler, or other projection of a Domain Api | The command's `decide`, or the entry's middleware and `validate` |
| An HTTP, CLI, or MCP surface written by hand beside a Domain Api | A projection of the Api; a smaller Api to publish less |
| Infrastructure imported into a `domain` package | The `server` package |
| Two ways to do one thing | One paved path; delete the other |

For each proposed new piece, name what it deletes. A tag, layer, or state that deletes nothing is ceremony.

## Fence the layout

Agents copy what they find, so a boundary that lives only in prose erodes. Put each rule on the highest rung that can hold it:

1. **Code.** A type or API that makes the wrong version unwritable: a schema at the boundary, a required service, a contract kit that projects surfaces.
2. **Static analysis.** An import-boundary or pattern rule in oxlint, with a fixture test that fails when the rule is broken.
3. **Repo law.** A line in `AGENTS.md`, only when neither rung above can hold it.

On the Domain path, the import rule admits only `@alchemy.run/domain` and `effect` into the `domain` package, and a test that expects `Domain.verify(Model)` to be empty fences the declaration itself.

When a bad pattern appears, write the rule that fails on it first, then fix every instance so the rule starts at zero findings. When some findings must stay, record them in a baseline that only shrinks. `project-scaffolding` covers the lint wiring.
