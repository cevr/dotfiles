# Mod architecture

Every mod is an Effect program modeled like an `@alchemy.run/domain` model, without the alchemy package, and laid out like a Go service. Its domain is pure: aggregates decide commands, and the domain declares, as `Context.Service` contracts, everything it needs from outside. Packages named after their dependency (OpenCode, the filesystem, a worker, gent) implement those contracts. One `cmd/` entry per binary wires them into OpenCode's plugin API. Read the `effect` skill (SKILL.md, `references/ARCHITECTURE.md` §Layout, and the PROGRAM_DESIGN, SERVICES_LAYERS, SCHEMA, TAGGED_VALUES and TESTING references) and the `alchemy` skill's `references/domain.md` §Layout, which maps the building blocks onto the layout, before changing a mod. The `alchemy-domain` skill's building-block templates still hold; its kind-suffixed file layout does not. This file says how those rules land here.

The installed Effect is the authority on its API: `mods/<mod>/node_modules/effect` (the fork's copy, 4.0.x; read its `AGENTS.md` and `ai-docs/`). At run time OpenCode hands every plugin its own `effect` and `@opencode/plugin` modules, so a mod always runs on the host's Effect instance.

## Layout

The orchestrate mod, as the example:

```text
mods/orchestrate/
  package.json              "domain": "orchestrate"; exports "./server" → cmd/server/main.ts
  orchestrate/              the domain: imports effect and ../../../lib/ only
    tool-call.ts            ToolCallId; the ToolCall decider; StartSubagent, UseTool, FinishSubagent and their events
    sabbath.ts              the Sabbath clock and the SabbathRest rejection
    pace.ts                 the pace values and the PaceHeld rejection
    role.ts                 roles and their agents
    errors.ts               failures several concepts share (only when they exist)
    service.ts              the contracts: CallLog, Sessions, Models, PoolPace, CodexAdmission, CompactionWindows
    laws.ts                 what every implementation of a contract owes, as a shared test suite
    model.ts                the handlers: gather inputs through contracts, send each command to its aggregate, record the outcome
    tool-call.test.ts       stories, over test Layers declared here
  filestore/                CallLog over the JSONL file, CompactionWindows over compact.json
  opencode/                 Sessions, Models and PoolPace over OpenCode's plugin context and RPC
  codex/                    CodexAdmission over the Codex budget script
  memory/                   in-memory implementations, for the cmd tests and the laws
  cmd/
    server/main.ts          the plugin: the only composition root
    server/main.test.ts     the plugin seam, over memory and test Layers
```

- **A folder per responsibility.** The domain folder sits at the centre, named for the mod's domain and declared in `package.json` as `"domain"`. Every other folder is named after its dependency: `opencode` (the plugin context, RPC, sessions), `filestore`, `worker`, `gent`, `process`, `memory`. A mod is one package because OpenCode loads it as one; its folders play the role of the Go layout's packages, and `tests/layout.test.ts` fences them.
- **Files are named by concept** (`tool-call.ts`, `sabbath.ts`, `errors.ts`, `service.ts`), never by kind (`*.aggregate.ts`, `*.command.ts`, `commands/`, `services/`, `host/`). The declaration says what kind of thing it is. Split a file by concept when it grows (`refusal.ts` out of `tool-call.ts`).
- **The consumer owns the contract.** The domain declares each service it needs as a `Context.Service` in `service.ts` (or in the file of its concept), with its failures, and states what every implementation owes in `laws.ts`: a function that runs the shared cases against a Layer. Implementations import the domain; the domain imports no implementation.
- **Implementations export Layers for the domain's contracts** and map their vendor errors to the domain's failures at that edge (`Effect.mapError`, `Effect.tryPromise` with a classifying `catch`). Each runs the domain's laws in its own test beside it.
- **`cmd/<binary>/main.ts` is the only composition root**: `cmd/server/main.ts` for a server plugin, `cmd/tui/main.tsx` for a TUI plugin. It decodes options, picks one implementation per contract, builds the Layer once and registers the hooks. Swapping a store is a one-line change there.
- **UI folders** (`tui/`) hold the components and what they draw; the `cmd/tui` entry runs them.
- **Tests sit beside their code** (`tool-call.test.ts`, `filestore/call-log.test.ts`, `cmd/server/main.test.ts`). The real-OpenCode acceptance tests stay in `opencode/tests/`, because they run several mods together.
- **Imports point one way**: `cmd/*` → implementation and UI folders → the domain folder → `lib/` → `effect`. Nothing imports `cmd/`. Use relative paths with the `.ts` extension and no barrel files. Another mod is reached only through a file its `package.json` `exports` lists (pool's `./status` protocol); `tests/layout.test.ts` checks every arrow.
- **The domain folder** never imports `@opencode/plugin`, `node:*`, `bun`, `Bun` or another folder of the mod. Its tests and `laws.ts` may import `bun:test` and `lib/story.ts`.
- `lib/` (`opencode/lib/`) is the shared kit every mod uses: `decider.ts` (`Fold`, `Decider`, `fold`) and `story.ts` (`make(decider)(given, clock, when, then, rejected, state, view)`), with their tests beside them. Import it relative to the file: `../../../lib/` from the domain folder, one more `../` per folder below. `scripts/link-fork.ts` links `lib/node_modules` as it does the mods'. Nothing domain-specific goes there.

## Building blocks without alchemy

Each block lands in the file of its concept: an aggregate with its id, its commands and their events; a rejection beside the one command that returns it, in `errors.ts` once several share it; a view, policy or protocol in the file of the concept it is about.

| alchemy-domain | Here |
| --- | --- |
| `Domain.Event("X", fields)` | `Schema.TaggedStruct("X", fields)` plus a same-name interface |
| `Domain.Command("X", { input, events, rejects })` | `Schema.TaggedStruct("X", input)`. Its file exports the events and rejections too, and a `X.Rejections` union type |
| `Domain.Rejection("X", fields)` | `Schema.TaggedError<X>()("X", fields)`, always carrying its evidence |
| `Domain.Aggregate` | a `Decider` from `lib/decider.ts`: `{ initial, decide(state, command, now) → Effect<events, rejection>, evolve(state, event) → state }`. Its id is a branded schema, or a struct schema when the key has parts (`ToolCallId { sessionID, callID }`). A decider whose rules need no history keeps a trivial state |
| `Domain.View` | `{ initial, evolve(state, event) }` keyed by what it is about; a read is a pure function of that state |
| `Domain.Policy` | a pure `react(event) → commands`, run by the plugin's dispatcher; its commands carry deterministic ids |
| `Domain.External` | a `Context.Service` contract in the domain's `service.ts`, with its laws, implemented in a folder named after its dependency |
| `Domain.Model` + handlers Layer | the domain's `model.ts`: the handlers, effectful, requiring only the contracts. `cmd/server/main.ts` builds their Layer once and registers the hooks |

The rules that keep a model correct come over unchanged:

- `decide` is pure. It reads time from its `now` argument and nothing from outside. It returns events, `[]` when the state already is what the command asks for, or a declared rejection. It never performs I/O.
- `evolve` and a view's `evolve` are total and never fail. Events carry the outcome `decide` worked out, so `evolve` copies it.
- Every command goes through its aggregate's `decide`, the one decision entry point, so a story exercises what production runs. A handler narrows the rejection union with `Effect.catchTag` where it needs to.
- `decide` returns events or a rejection, never both. A refusal someone must see later (a `denied` line in a log) is recorded by the handler from the rejection.
- Never `throw`. Expected failures are tagged errors in `E`; adapters classify a host or SDK failure once, with `Effect.tryPromise`.
- Persistence is a port. An aggregate whose history someone reads (the status pane, an audit) is stored as its events through an `EventLog` contract, keyed `stream:seq`. Otherwise store the folded state. Each mod chooses which and says so in its README. A format another program already reads (orchestrate's JSONL call log, which the status mod reads) stays byte-compatible: its lines are a view of the events, written by the store implementation.
- Policies run at least once, so their effects are idempotent.

## The composition root

`cmd/server/main.ts` (and `cmd/tui/main.tsx`) are the only files that touch `@opencode/plugin/effect` and `@opencode/plugin/tui`, apart from the `opencode/` implementations of the domain's contracts:

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
- Hooks registered through `ctx` are owned by the plugin's scope. Background fibers start with `Effect.forkScoped`.
- A handler is thin: decode, read context, call the service, map the small public error set.
- Contracts are `Context.Service` classes with package-qualified keys (`dotfiles-opencode/<mod>/<Noun>`). Public and non-trivial operations are `Effect.fn("<Noun>.<operation>")`.
- RPC protocols other mods read (`dotfiles-opencode.pool` and the rest) keep their ids and definition literals byte for byte in the domain file of their concept, listed in the mod's `package.json` `exports` (the host's `rpc.register` and `client.rpc` take those literals), with Schema for the answers they carry. A reader imports only that exported file, and decodes an answer with its own schema.

## TUI mods

Prime and the status pane draw with Solid through `@opencode/plugin/tui`. What they show comes from the domain: a fold over events is a view (the agent list), and a pure projection a component draws is a value in the file of its concept (tool-call groups, pane rows), tested beside it. The components live in `tui/` and stay thin: they read a view and draw it. `cmd/tui/main.tsx` registers them.

## Tests

- **Stories** test the model through `lib/story.ts`: given events, when a command, then the events, the rejection, or a view's state. They cover the happy path, every rejection and every policy reaction. They are pure and fast. A view with no aggregate (its events are another program's records, such as the call log the status pane reads) is tested beside its file by folding events with `fold` from `lib/decider.ts`.
- **Laws** run in each implementation's test beside it: the domain's `laws.ts` over that implementation's Layer, so `memory/` and the real store owe the same behaviour.
- **Plugin seam tests** (`cmd/server/main.test.ts`) run the composition root over `memory/` and test Layers with explicit state and failure controls. No module mocks, spies or `beforeEach`; fixtures are Layers or scoped `acquireRelease`.
- **The real-OpenCode tests in `tests/`** are the acceptance check. A refactor keeps every one of them green with their assertions unchanged. Change one only to follow a renamed import, and say so in the commit.

## Migrating a mod

Behaviour stays the same; only the shape changes. In order:

1. Name the facts, commands, rejections, aggregates, views, policies and contracts the mod already has. Write them in its README as a short model section.
2. Write the domain folder and its stories first, moving the pure logic that exists today. Declare the contracts and their laws.
3. Move I/O into folders named after their dependency, each running the laws.
4. Rewrite the entry as `cmd/<binary>/main.ts` and point `package.json` `exports` at it. Delete what it replaced.
5. Run the full gate (`README.md`, Checks). Every existing test passes, `tests/layout.test.ts` included.
