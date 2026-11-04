# Mod architecture

Every mod is an Effect program shaped like an `@alchemy.run/domain` model, without the alchemy package. Its domain is pure and is decided by aggregates. Adapters reach OpenCode, the filesystem and outside systems. One composition root wires them into OpenCode's plugin API. Read the `effect` skill (SKILL.md and the PROGRAM_DESIGN, SERVICES_LAYERS, SCHEMA, TAGGED_VALUES and TESTING references) and the `alchemy-domain` skill (modeling, layout, building blocks, testing) before changing a mod. This file says how their rules land here.

The installed Effect is the authority on its API: `mods/<mod>/node_modules/effect` (the fork's copy, 4.0.x; read its `AGENTS.md` and `ai-docs/`). At run time OpenCode hands every plugin its own `effect` and `@opencode/plugin` modules, so a mod always runs on the host's Effect instance.

## Layout

```text
mods/<mod>/
  package.json              exports "./server" → src/<Mod>.plugin.ts (a TUI mod: "./tui" → src/<Mod>.tui.tsx)
  src/
    domain/                 the pure model; imports `effect` and ../../../lib only
      <Subdomain>/
        <Noun>.id.ts                branded id schema
        <Noun>.aggregate.ts         state schema, initial, decide, evolve
        <Verb><Noun>.command.ts     the command, the events it records, the rejections only it returns
        <Name>.rejection.ts         a rejection several commands return
        <Noun>.view.ts              a read model: a fold of events into state, keyed by what it is about
        <Noun>.policy.ts            "whenever X, do Y": event in, commands out
        <Noun>.external.ts          a system outside the model: a Context.Service interface and its errors
      <Value>.ts                    plain value schemas and pure helpers
      <Mod>.model.ts                the handlers: gather inputs through externals, send each command to its aggregate, record the outcome
    host/                   adapters: OpenCode's plugin context, storage, files, processes, HTTP
      <Noun>.ts                     Context.Service + its live Layer; a faithful layerTest beside it
    <Mod>.plugin.ts         the composition root
  test/
    <Subdomain>.story.test.ts       given events, when a command, then events, a rejection, a view
    <Value>.test.ts                 a pure value module's own cases
    <Mod>.plugin.test.ts            the plugin seam with test layers
```

- One block per file, named by its kind. Folders are subdomains. No barrel files. Import with relative paths and the `.ts` extension.
- `domain/` never imports `@opencode/plugin`, `node:*`, `Bun` or a host adapter. What it needs from outside is an `.external.ts` service, and its implementation lives in `host/`.
- `lib/` (`opencode/lib/`) holds the few shared helpers every mod uses: `decider.ts` (`Fold`, `Decider`, `fold`) and `story.ts` (`make(decider)(given, clock, when, then, rejected, state, view)`), with their own tests beside them. Import it relative to the file: `../../../lib/` from `src/`, one more `../` per folder below. `scripts/link-fork.ts` links `lib/node_modules` as it does the mods'. Nothing domain-specific goes there.
- A subdomain may hold only externals or values when it has no aggregate (`Agents/CompactionWindows.external.ts`).

## Building blocks without alchemy

| alchemy-domain | Here |
| --- | --- |
| `Domain.Event("X", fields)` | `Schema.TaggedStruct("X", fields)` plus a same-name interface |
| `Domain.Command("X", { input, events, rejects })` | `Schema.TaggedStruct("X", input)`. Its file exports the events and rejections too, and a `X.Rejections` union type |
| `Domain.Rejection("X", fields)` | `Schema.TaggedError<X>()("X", fields)`, always carrying its evidence |
| `Domain.Aggregate` | a `Decider` from `lib/decider.ts`: `{ initial, decide(state, command, now) → Effect<events, rejection>, evolve(state, event) → state }`. Its id is a branded schema, or a struct schema when the key has parts (`ToolCallId { sessionID, callID }`). A decider whose rules need no history keeps a trivial state |
| `Domain.View` | `{ initial, evolve(state, event) }` keyed by what it is about; a read is a pure function of that state |
| `Domain.Policy` | a pure `react(event) → commands`, run by the plugin's dispatcher; its commands carry deterministic ids |
| `Domain.External` | a `Context.Service` declared in `domain/`, implemented in `host/` |
| `Domain.Model` + handlers Layer | `domain/<Mod>.model.ts`: the handlers, effectful, requiring only the externals. `<Mod>.plugin.ts` builds their Layer once and registers the hooks |

The rules that keep a model correct come over unchanged:

- `decide` is pure. It reads time from its `now` argument and nothing from outside. It returns events, `[]` when the state already is what the command asks for, or a declared rejection. It never performs I/O.
- `evolve` and a view's `evolve` are total and never fail. Events carry the outcome `decide` worked out, so `evolve` copies it.
- Every command goes through its aggregate's `decide`, the one decision entry point, so a story exercises what production runs. A handler narrows the rejection union with `Effect.catchTag` where it needs to.
- `decide` returns events or a rejection, never both. A refusal someone must see later (a `denied` line in a log) is recorded by the handler from the rejection.
- Never `throw`. Expected failures are tagged errors in `E`; adapters classify a host or SDK failure once, with `Effect.tryPromise`.
- Persistence is a port. An aggregate whose history someone reads (the status pane, an audit) is stored as its events in an `EventLog` adapter, keyed `stream:seq`. Otherwise store the folded state. Each mod chooses which and says so in its README. A format another program already reads (orchestrate's JSONL call log, which the status mod reads) stays byte-compatible: its lines are a view of the events, written by the store adapter.
- Policies run at least once, so their effects are idempotent.

## The composition root

`<Mod>.plugin.ts` is the only file that touches `@opencode/plugin/effect`:

```ts
export default Plugin.define({
  id: "dotfiles-opencode.<mod>",
  effect: Effect.fn(function* (ctx) {
    const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(Effect.orDie)
    const services = yield* Layer.build(ModLive(ctx, options))
    // Register hooks. Each handler decodes the host event, calls one domain
    // service operation, and maps its rejections to the host's answer (Tool.Error).
  }),
})
```

- Options are a `Schema` decoded here; a default lives in the schema. An absent option takes its default; a malformed one is a defect at setup (`Effect.orDie`, naming the option), never a silent fallback. A malformed *reply* from another plugin or system at run time is different: its adapter decides (the pool's pace answer fails open).
- Errors the host reads come from the host: `Tool` (and `Tool.Error`) from `@opencode/plugin/effect`, never a local copy.
- Transform callbacks (`ctx.agent.transform` and the rest) are synchronous. Load what they need before registering, or run a synchronous effect inside (`Effect.runSync` of a sync read).
- Decisions read `now` from the mod's clock (the `now` option, when a test fixes it). Timestamps a log writes may use the wall clock; say which in the README.
- Hooks registered through `ctx` are owned by the plugin's scope. Background fibers start with `Effect.forkScoped`.
- A handler is thin: decode, read context, call the service, map the small public error set.
- Services are `Context.Service` classes with package-qualified keys (`dotfiles-opencode/<mod>/<Noun>`). Public and non-trivial operations are `Effect.fn("<Noun>.<operation>")`.
- RPC protocols other mods read (`dotfiles-opencode.pool` and the rest) keep their ids and shapes, defined with Schema in `domain/`.

## TUI mods

Prime and the status pane draw with Solid through `@opencode/plugin/tui`. What they show comes from views in `domain/`: pure folds and projections, such as tool-call groups or the agent list, with stories. Components stay thin: they read a view and draw it.

## Tests

- **Stories** test the model through `lib/story.ts`: given events, when a command, then the events, the rejection, or a view's state. They cover the happy path, every rejection and every policy reaction. They are pure and fast.
- **Plugin seam tests** run the composition root against `layerTest` fakes with explicit state and failure controls. No module mocks, spies or `beforeEach`; fixtures are Layers or scoped `acquireRelease`.
- **The real-OpenCode tests in `tests/`** are the acceptance check. A refactor keeps every one of them green with their assertions unchanged. Change one only to follow a renamed import, and say so in the commit.

## Migrating a mod

Behaviour stays the same; only the shape changes. In order:

1. Name the facts, commands, rejections, aggregates, views, policies and outside systems the mod already has. Write them in its README as a short model section.
2. Write the domain blocks and their stories first, moving the pure logic that exists today.
3. Move I/O into `host/` adapters with test layers.
4. Rewrite the entry as `<Mod>.plugin.ts`. Delete what it replaced.
5. Run the full gate (`README.md`, Checks). Every existing test passes.
