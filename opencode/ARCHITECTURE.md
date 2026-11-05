# Mod architecture

Every mod is an Effect program modeled like an `@alchemy.run/domain` model, without the alchemy package, and laid out like a Go service. A mod is one bounded context and one workspace package. Its domain files sit at its root and are pure: aggregates decide commands, and the domain declares, as `Context.Service` contracts, everything it needs from outside. Folders inside the mod, named after their dependency (OpenCode, the filesystem, a worker, gent), implement those contracts. One `cmd/<plugin>` package per plugin wires them into OpenCode's plugin API. Read the `effect` skill (SKILL.md, `references/ARCHITECTURE.md` §Layout, and the PROGRAM_DESIGN, SERVICES_LAYERS, SCHEMA, TAGGED_VALUES and TESTING references), the `alchemy` skill's `references/domain.md` §Layout, which maps the building blocks onto the layout, and the `project-scaffolding` skill's `references/agent-fence.md`, before changing a mod. The `alchemy-domain` skill's building-block templates still hold; its kind-suffixed file layout does not. This file says how those rules land here.

The installed Effect is the authority on its API: `mods/<mod>/node_modules/effect` (the fork's copy, 4.0.x; read its `AGENTS.md` and `ai-docs/`). At run time OpenCode hands every plugin its own `effect` and `@opencode/plugin` modules, so a mod always runs on the host's Effect instance.

## Layout

The orchestrate mod, as the example:

```text
opencode/
  mods/orchestrate/         @dotfiles/opencode-orchestrate: the context; exports "./*": "./*.ts"
    tool-call.ts            ToolCallId; the ToolCall decider; StartSubagent, OpenLatch, UseTool, FinishSubagent, their events and StillLatched
    sabbath.ts              the Sabbath clock and the SabbathRest rejection
    pace.ts                 the pace values and the PaceHeld rejection (a hold no latch could keep)
    role.ts                 roles and their agents
    errors.ts               failures several concepts share (only when they exist)
    service.ts              the contracts: CallLog, Sessions, Models, PoolPace, CodexAdmission, Latches, CompactionWindows
    laws.ts                 what every implementation of a contract owes, as a shared test suite
    model.ts                the handlers: gather inputs through contracts, send each command to its aggregate, record the outcome
    tool-call.test.ts       stories, over test Layers declared here
    filestore/              CallLog over the JSONL file, CompactionWindows over compact.json  → @dotfiles/opencode-orchestrate/filestore/call-log
    opencode/               Sessions, Models, PoolPace and Latches (the wakes' latch RPC) over OpenCode's plugin context and RPC
    codex/                  CodexAdmission over the Codex budget script
    memory/                 in-memory implementations, for the cmd tests and the laws
  cmd/orchestrate/          @dotfiles/opencode-cmd-orchestrate: the plugin OpenCode loads
    package.json            exports "./server": "./server.ts"; depends on the context and the vendor packages it binds
    server.ts               the only composition root
    server.test.ts          the plugin seam, over memory and test Layers
  decider/                  @dotfiles/decider: Decider, fold and stories; no domain code
```

- **A mod is one context and one workspace package**, `mods/<mod>`, named `@dotfiles/opencode-<mod>`. Its domain files sit at its root. Name each file by its concept (`tool-call.ts`, `sabbath.ts`, `errors.ts`, `service.ts`), never by its kind (`*.aggregate.ts`, `*.command.ts`, `commands/`, `services/`, `host/`, `src/`, `test/`); the declaration says what kind of thing it is. Split a file by concept when it grows (`refusal.ts` out of `tool-call.ts`).
- **The consumer owns the contract.** The domain declares each service it needs as a `Context.Service` in `service.ts` (or in the file of its concept), with its failures, and states what every implementation owes in `laws.ts`: a function that runs the shared cases against a Layer. Implementations import the domain; the domain imports no implementation.
- **Implementations nest under the context, in folders named after their dependency**: `opencode` (the plugin context, RPC, sessions), `filestore`, `worker`, `gent`, `process`, `memory`. Each exports Layers for the domain's contracts, maps its vendor errors to the domain's failures at that edge (`Effect.mapError`, `Effect.tryPromise` with a classifying `catch`), and runs the domain's laws in its own test beside it.
- **Effect-free programs** (the kernel's worker program) may import a domain file only through `import type`, or when that file's runtime imports are themselves such files (none reaches Effect or a vendor package). Each domain file used this way declares that constraint at its top.
- **`memory/` holds an implementation only when a test uses it.** Do not add an unused double to complete the folder layout.
- **UI folders** (`tui/`) hold the components of that context and what they draw; a `cmd/` package runs them.
- **`cmd/<plugin>` is the only composition root**, one workspace package per plugin OpenCode loads, named `@dotfiles/opencode-cmd-<plugin>`. OpenCode finds a local plugin's parts through its `package.json` `exports`, so the entries are named for those parts: `server.ts` for the server plugin, `tui.tsx` for the TUI plugin. Those exports are for OpenCode's loader; no code imports a `cmd/` package. The entry decodes options, picks one implementation per contract, builds the Layer once and registers the hooks, so swapping a store is a one-line change there.
- **Packages and subpaths.** The workspaces are `mods/*`, `cmd/*` and `decider`. A context exports its files by path, `"exports": { "./*": "./*.ts" }`, which also reaches its folders, so an import names the concept it reaches (`@dotfiles/opencode-orchestrate/filestore/call-log`). Write no barrel files. Inside a package, import with relative paths and the `.ts` extension; across packages, by package name. A package lists each workspace package it imports as `"workspace:*"`.
- **Vendor packages.** A vendor package an implementation folder uses (the kernel's `oxc-parser`) is an optional peer of the context and a dev dependency, so the folder typechecks; the `cmd/` package that binds that implementation lists it as a dependency. The host's own modules (`effect`, `@opencode/plugin`, `@opentui/*`, `solid-js`) are not listed: OpenCode provides them at run time, and `scripts/link-fork.ts` links them from the fork for tooling.
- **Contexts meet through contracts.** A mod imports another mod only through a contract or protocol file it names for that purpose (pool's `status.ts`, which orchestrate and status read; wake's `latch.ts`, the latch RPC and opener orchestrate serves), never its implementations or model.
- **`decider/`** (`@dotfiles/decider`) is the shared non-domain kit: `decider.ts` (`Fold`, `Decider`, `fold`) and `story.ts` (`make(decider)(given, clock, when, then, rejected, state, view)`), with their tests beside them. Nothing domain-specific goes there.
- **Tests sit beside their code** (`tool-call.test.ts`, `filestore/call-log.test.ts`, `cmd/orchestrate/server.test.ts`). The real-OpenCode acceptance tests stay in `opencode/tests/`, because they run several plugins together.
- **The fence is oxlint** (`.oxlintrc.json`, `bun run lint`): one `no-restricted-imports` override per context on `mods/<mod>/*.ts`, the domain files only. They import `effect`, `@dotfiles/decider/*`, their own root files, and another context's contract files; never `@opencode/*`, `node:*`, `bun`, a vendor package, or one of their own folders (`./*/**`). The domain's tests and `laws.ts` may also import `bun:test`. A second override per UI folder keeps it off the implementations. Before trusting a new override, add a file that breaks it and watch `oxlint` fail. `tests/layout.test.ts` checks what is not an import: no file or folder in a context named by its kind.

## Building blocks without alchemy

Each block lands in the file of its concept: an aggregate with its id, its commands and their events; a rejection beside the one command that returns it, in `errors.ts` once several share it; a view, policy or protocol in the file of the concept it is about.

| alchemy-domain | Here |
| --- | --- |
| `Domain.Event("X", fields)` | `Schema.TaggedStruct("X", fields)` plus a same-name interface |
| `Domain.Command("X", { input, events, rejects })` | `Schema.TaggedStruct("X", input)`. Its file exports the events and rejections too, and a `X.Rejections` union type |
| `Domain.Rejection("X", fields)` | `Schema.TaggedError<X>()("X", fields)`, always carrying its evidence |
| `Domain.Aggregate` | a `Decider` from `@dotfiles/decider/decider`: `{ initial, decide(state, command, now) → Effect<events, rejection>, evolve(state, event) → state }`. Its id is a branded schema, or a struct schema when the key has parts (`ToolCallId { sessionID, callID }`). A decider whose rules need no history keeps a trivial state |
| `Domain.View` | `{ initial, evolve(state, event) }` keyed by what it is about; a read is a pure function of that state |
| `Domain.Policy` | a pure `react(event) → commands`, run by the plugin's dispatcher; its commands carry deterministic ids |
| `Domain.External` | a `Context.Service` contract in the domain's `service.ts`, with its laws, implemented in a folder named after its dependency |
| `Domain.Model` + handlers Layer | the domain's `model.ts`: the handlers, effectful, requiring only the contracts. `cmd/<plugin>/server.ts` builds their Layer once and registers the hooks |

The rules that keep a model correct come over unchanged:

- `decide` is pure. It reads time from its `now` argument and nothing from outside. It returns events, `[]` when the state already is what the command asks for, or a declared rejection. It never performs I/O.
- `evolve` and a view's `evolve` are total and never fail. Events carry the outcome `decide` worked out, so `evolve` copies it.
- Every command goes through its aggregate's `decide`, the one decision entry point, so a story exercises what production runs. A handler narrows the rejection union with `Effect.catchTag` where it needs to.
- `decide` returns events or a rejection, never both. A refusal someone must see later (a `denied` line in a log) is recorded by the handler from the rejection.
- Never `throw`. Expected failures are tagged errors in `E`; adapters classify a host or SDK failure once, with `Effect.tryPromise`.
- Persistence is a port. An aggregate whose history someone reads (the status pane, an audit) is stored as its events through an `EventLog` contract, keyed `stream:seq`. Otherwise store the folded state. Each mod chooses which and says so in its README. A format another program already reads (orchestrate's JSONL call log, which the status mod reads) stays byte-compatible: its lines are a view of the events, written by the store implementation.
- Live resources (a process, a socket) belong to the implementation that owns them, not to an aggregate. The aggregate records only the facts about the resource.
- Policies run at least once, so their effects are idempotent.

## The composition root

`cmd/<plugin>/server.ts` (and `tui.tsx`) are the only files that touch `@opencode/plugin/effect` and `@opencode/plugin/tui`, apart from the `opencode/` implementations of the domain's contracts:

```ts
export default Plugin.define({
  id: "dotfiles-opencode.<mod>",
  effect: Effect.fn(function* (ctx) {
    const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(Effect.orDie)
    const services = yield* Layer.build(Live(ctx, options)) // one implementation per contract
    // Register hooks. Each handler decodes the host event, calls one domain
    // service operation, and maps its rejections to the host's answer (Tool.Error).
  }),
})
```

- Options are a `Schema` decoded here; a default lives in the schema. An absent option takes its default; a malformed one is a defect at setup (`Effect.orDie`, naming the option), never a silent fallback. An option set to `undefined` counts as absent: in-process hosts pass unset options as `undefined`, and JSON cannot write it. A malformed *reply* from another plugin or system at run time is different: its adapter decides (the pool's pace answer fails open).
- Errors the host reads come from the host: `Tool` (and `Tool.Error`) from `@opencode/plugin/effect`, never a local copy.
- Transform callbacks (`ctx.agent.transform` and the rest) are synchronous. Load what they need before registering, or run a synchronous effect inside (`Effect.runSync` of a sync read).
- Decisions read `now` from the mod's clock (the `now` option, when a test fixes it). Timestamps a log writes may use the wall clock; say which in the README.
- A contract whose implementation depends on one call's context (`Tool.Context`, such as the kernel's `Toolbox`) is provided per call, around that call, by the composition root. Leave it out of the Layer built at setup.
- Hooks registered through `ctx` are owned by the plugin's scope. Background fibers start with `Effect.forkScoped`.
- A handler is thin: decode, read context, call the service, map the small public error set.
- Contracts are `Context.Service` classes with package-qualified keys (`dotfiles-opencode/<mod>/<Noun>`). Public and non-trivial operations are `Effect.fn("<Noun>.<operation>")`.
- RPC protocols other mods read (`dotfiles-opencode.pool` and the rest) keep their ids and definition literals byte for byte in the domain file of their concept, which another mod imports by package name (the host's `rpc.register` and `client.rpc` take those literals), with Schema for the answers they carry. A reader imports only that file, and decodes an answer with its own schema.

## TUI mods

Prime and the status pane draw with Solid through `@opencode/plugin/tui`. What they show comes from the domain: a fold over events is a view (the agent list), and a pure projection a component draws is a value in the file of its concept (tool-call groups, pane rows), tested beside it. The components live in `tui/` and stay thin: they read a view and draw it. `cmd/<plugin>/tui.tsx` registers them.

## Tests

- **Stories** test the model through `@dotfiles/decider/story`: given events, when a command, then the events, the rejection, or a view's state. They cover the happy path, every rejection and every policy reaction. They are pure and fast. A view with no aggregate (its events are another program's records, such as the call log the status pane reads) is tested beside its file by folding events with `fold` from `@dotfiles/decider/decider`.
- **Laws** run in each implementation's test beside it: the domain's `laws.ts` over that implementation's Layer, so `memory/` and the real store owe the same behaviour.
- When a contract's only implementation is a program the repo owns and can run in a scratch directory (the kernel's worker), its laws and plugin seam test may run that program live instead of using a `memory/` double. Scope the program and scratch directory to the test.
- **Plugin seam tests** (`cmd/<plugin>/server.test.ts`) run the composition root over `memory/` and test Layers with explicit state and failure controls. No module mocks, spies or `beforeEach`; fixtures are Layers or scoped `acquireRelease`.
- **The real-OpenCode tests in `tests/`** are the acceptance check. A refactor keeps every one of them green with their assertions unchanged. Change one only to follow a renamed import, and say so in the commit.

## Migrating a mod

Behaviour stays the same; only the shape changes. In order:

1. Name the facts, commands, rejections, aggregates, views, policies and contracts the mod already has. Write them in its README as a short model section.
2. Write the domain files and their stories first, moving the pure logic that exists today. Declare the contracts and their laws.
3. Move I/O into folders named after their dependency, each running the laws.
4. Write the entry as `cmd/<plugin>/server.ts` (and `tui.tsx`) in its own package, and point `scripts/daily.ts`, the testbeds and the acceptance tests at `cmd/<plugin>`. Delete what it replaced.
5. Add the context's override to `.oxlintrc.json`, break it once to watch it fail, and run the full gate (`AGENTS.md`, Checks).
