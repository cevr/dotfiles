# Domain Backends

Our policy for backends written as a domain model with `@alchemy.run/domain`: when to use the package, where its build guidance lives, our layout for it, and which client surfaces its Api projects. How to write the model itself is the upstream `alchemy-domain` skill's job.

## Contents

- When to reach for it
- Build it from the upstream skill
- Layout
- One Api, every surface
- Upgrading from beta.85
- Gaps at beta.87
- Testing

## When to reach for it

`@alchemy.run/domain` (Apache-2.0, released in lockstep with `alchemy`) models a backend as typed messages: **commands** that **aggregates** decide, **events** they record, **rejections** they return, **views** folded from events, **policies** that react, **sagas** for processes with steps and compensation, **projections** into stores you own, **queries** that answer questions across keys from those stores, and **external systems** behind declared operations. A **platform** Layer hosts the model: `Domain.InMemory` in one process, or Durable Objects through `layerDurableObjects()` from `@alchemy.run/domain/Cloudflare`, `@alchemy.run/domain/Rivet`, or `layerEntities()` from `@alchemy.run/domain/EffectCluster`. Tests and production run the same model.

Reach for it when all three hold:

- The backend records business facts and enforces rules over them: requests are accepted or refused, state changes only through those decisions, and reads are shaped for the screens that ask.
- Production runs on Cloudflare Durable Objects. Rivet and Effect Cluster joined as durable platforms in beta.86, and Rivet's pools include Railway services (`@alchemy.run/rivet/Railway`); we have reviewed only the Cloudflare platform, so the others are unproven until a project deploys one. `Domain.InMemory` keeps state in the process and loses it on restart.
- Several clients reach it (a web app, a support console, a CLI, an agent, a partner), or the rules are worth stating as runnable examples.

Build a hand-built Effect app instead (the `effect` skill, `references/ARCHITECTURE.md`) for a library, a CLI or tool over local files or a vendor API, request/response work with no state of its own, a server that must run on Railway or another container host (until a Rivet or Effect Cluster deploy is proven), or a product that needs a surface the Domain Api lacks (§Gaps).

## Build it from the upstream skill

The package ships an agent skill, `alchemy-domain`: the modeling method, a file layout, a template per building block, stories, hosting (Cloudflare, Rivet, Effect Cluster) and a foldkit frontend. Read it before you model anything, and follow its workflow with our layout (§Layout) in place of its own. Take the copy that matches the pinned version:

1. `node_modules/@alchemy.run/domain/skills/alchemy-domain/` in the project. The npm package ships it, references included.
2. Otherwise `okra repo fetch npm:@alchemy.run/domain@<version>`, then `skills/alchemy-domain/` inside it.
3. For unreleased changes, `okra repo fetch alchemy-run/alchemy`, then `packages/domain/skills/alchemy-domain/`. That is `main`, which can run ahead of the pinned release.

The copy okra installs in our skills (`alchemy-domain`) follows `main`; when it and the pinned copy disagree, the pinned copy wins. Its `references/hosting.md` still says Rivet and Effect Cluster hold no WebSockets, but at beta.87 the docs and source push live reads over `Domain.protocolWebSocket` on every platform.

The docs live at https://alchemy.run/domain, with every page listed in https://alchemy.run/llms.txt. The worked project is `examples/cloudflare-domain` in the repo: a bank with domain, server and foldkit web packages, a story suite, Api tests, and a deploy test. When the docs and the source disagree, the source at the pinned version wins (SKILL.md §Source Rule).

## Layout

Lay the project out by our Go-style rule (the `effect` skill, `references/ARCHITECTURE.md` §Layout), in place of the upstream skill's `references/layout.md`: files by concept, the consumer owns the contract, implementations named after their dependency, and `cmd/` per binary. The upstream bank, laid out our way:

```text
bank/
  bank/                    @acme/bank: the context
    account.ts             AccountId; the Account aggregate; OpenAccount, WithdrawMoney and their events
    transfer.ts            the Transfer aggregate, RequestTransfer, the ExecuteTransfer saga
    errors.ts              rejections that several commands share (NotOpen)
    statement.ts           the AccountSummary and Statement views, and their validate Layers
    fraud.ts               the FraudCheck external system (declaration) and the FraudReview policy
    ledger.ts              the Ledger projection, the AccountLedger query, the LedgerStore port both use
    session.ts             the Session middleware declaration, its error, the CurrentActor context
    api.ts                 CustomerApi; one Api per kind of client
    model.ts               Domain.Model and its handlers Layer (every policy, saga, projection, query and guarded read)
    bank.test.ts           stories and Domain.verify, over test Layers declared here
    memory/                LedgerStore in memory            → @acme/bank/memory/ledger
    d1/                    LedgerStore over D1
    sift/                  FraudCheck over Sift
    workos/                SessionLive: verifies sessions against WorkOS
    web/                   the foldkit app: Model, Message, update, view; no entry point
  cmd/
    bank-worker/           main.ts: the Worker; api.test.ts: an Api test per access rule
    bank-web/              entry.ts, worker.ts, index.html, vite.config.ts
    bank/                  main.ts: toCli(CustomerApi, { expose }) over Domain.protocolHttp
  alchemy.run.ts           the stack: the bank-worker and bank-web resources
  test/integ.test.ts       deploys the stack and drives it
```

Follow the upstream skill's workflow with this layout in its step 2. Its building-block templates hold unchanged; only the file each block lands in moves.

- **A building block lands in the file of its concept**: an aggregate with its id, its commands and their events; a rejection beside the one command that returns it, in `errors.ts` once several share it; a policy or saga beside the concept it reacts to; a query beside the projection whose store it reads. A block's Live Layer (`AccountSummaryLive`, `AccountLedgerLive`) sits in the block's file unless it touches infrastructure. Split a file by concept when it grows.
- **The model declares every port** (`Context.Service`), external system and middleware it uses. Each implementation lives in a folder of the context named after its dependency, the memory one included.
- **Fence the domain files** (`bank/*.ts`) with an oxlint import rule that admits only `@alchemy.run/domain` and `effect`. That boundary is what lets stories run with no cloud account.
- **Pin `@alchemy.run/domain` at Alchemy's exact version** wherever it is used. It peers on `alchemy` at that exact version and on `effect` `^4.1.4` (from beta.86), so the context package lists `alchemy` too, though its code never imports it. The platform packages (`@alchemy.run/cloudflare`, `@alchemy.run/rivet`, `@alchemy.run/effect-cluster`) and the vendor SDKs are optional peers of the context, for its adapter folders.
- **One context per model** (bounded context), each a top-level folder. Models reach each other through Apis, never through each other's aggregates.
- **The Worker's `cmd/` main is the composition root.** It builds one Layer (platform, `Model.layer(handlers)`, middleware, adapters) and serves the surfaces from it. Every other binary (the web app's Worker, the CLI) has its own `cmd/` folder.
- **A stack that hosts a model on Cloudflare registers `DomainCloudflare.providers()`** beside `Cloudflare.providers()` (`Layer.mergeAll`). Without it the deploy fails with no provider for `Cloudflare.Domain.Backfill`.
- **The web folder** imports the Apis, ids and value schemas from the domain files, and `@alchemy.run/domain` for the client protocols.
- **A web client calls the Api's client.** The package ships an adapter for foldkit (`@alchemy.run/domain/Foldkit`, upstream `references/frontend.md`); any other framework uses `MyApi.layerClient` over a protocol.

## One Api, every surface

A `Domain.Api` names what one kind of client may reach: the commands it may send, the views and streams it may read, and the queries it may ask. An aggregate's state is never served; a view projects what clients may see of it. The Api has no handlers. Each entry's middleware and its own check guard every call on every surface (a command in `decide`, a view or stream in its Layer's `validate`, a query in its handler), so authorization is written once, in the model. The Api is the contract; each surface is a projection the package derives from it.

| Surface | Projection | Gives | Omits |
| --- | --- | --- | --- |
| Effect RPC | the Api class | `yield* MyApi` returns `{ fetch }` for the Worker. `MyApi.client` and `layerClient` over `Domain.protocolHttp`, `protocolWebSocket` or `protocolInProcess`; shortcuts `clientHttp`, `clientWebSocket`, `clientInProcess` | nothing |
| Plain HTTP and OpenAPI | `toHttpApi(Api, { expose })` from `@alchemy.run/domain/Http` | `{ group, api, layer, layerFor }` for `HttpApiBuilder`, and `OpenApi.fromApi(api)`. A query answers the `QUERY` method with a JSON body; live reads stream as Server-Sent Events | a read's `where` filter |
| CLI | `toCli(Api, { expose })` from `@alchemy.run/domain/Cli` | An `effect/cli` command that calls the deployed Api over `Domain.protocolHttp`: kebab-case subcommands, typed flags, `--json`, results as JSON on stdout, rejections on stderr with exit 1 | `watch`, `events` |
| Agent tools, MCP | `toToolkit`, `toMcp` from `@alchemy.run/domain/Ai`, each with `expose` | An Effect AI `Toolkit` and its handler Layer for an in-app `LanguageModel`, or the same tools on `McpServer` | `watch`, `events` |
| Browser | `@alchemy.run/domain/Foldkit` | foldkit commands and view subscriptions | |

- **Give each kind of client its own Api** (customers, support, agents, a terminal). The Api decides what that client may reach at all.
- **`toHttpApi`, `toCli`, `toMcp` and `toToolkit` publish only what `expose` lists** (since beta.86): a command or query by name (`"DepositMoney"`, `"AccountLedger"`), a read as `"<Name>.<operation>"` (`"AccountSummary.get"`). A name the Api does not serve is a type error, and a call left out has no endpoint, subcommand or tool. They send the domain's own payloads, replies and state, so a field later added to a reply or view goes out unreviewed: keep them to internal tools (scripts, admin consoles, our own agents).
- **Give every declaration `{ description }` as its last argument**, written for whoever calls it. Tools, CLI help and the OpenAPI document show it.
- **Read your own write with the command's receipt.** A command returns `{ reply, stream, version }`; pass the receipt as `atLeast` to a view's `get`, `list` or `snapshot` or to a query.
- **Declare HTTP statuses on the failure schemas**: `Domain.Rejection("NotOwner", {}, { httpApiStatus: 403 })`, and `HttpApiSchema.status(401)` on a middleware error. An undeclared failure answers 422, and input that fails its schema answers 400.
- **A public or partner HTTP API** is your own `HttpApi`, with each endpoint's response schema beside it, whose handlers call `MyApi.clientInProcess` (passing the caller's headers, so the middleware still runs) and map the result to that schema. A field leaves only when someone adds it there.
- **An MCP server on a Worker** uses `McpServer.layerHttpRequestScoped` with the sessionless `McpProtocol.v2026_07_28`, since the work must end with the request.
- **Serve a projection's store through a `Domain.Query`** on the Api, never a hand-written route: its handler checks the caller and scopes the rows it reads, and it gets middleware, typed rejections, paging and `atLeast` with it.
- **Inside the model**, handlers reach aggregates and views as services (`yield* Account`). Everything outside the model goes through an Api.

## Upgrading from beta.85

beta.86 broke the package in several places. A model written against beta.85 needs each of these:

- **Imports**: `layerDurableObjects` moved from `@alchemy.run/cloudflare/Domain` to `@alchemy.run/domain/Cloudflare`, and the stack registers `DomainCloudflare.providers()` (§Layout).
- **Aggregates are no longer read**: `read` on an aggregate and `aggregates` on an Api are gone. Add a view for what clients saw, or a query that reads the aggregate with `yield* Account`.
- **`validate` moved off the view and stream declarations** onto their Layers (`AccountSummary.toLayer(...)`), merged into the handlers. `Model.layer(handlers)` is a type error until every guarded view and stream has one.
- **`attributes` is gone** from commands, events and rejections. Record a payload value with `Effect.annotateCurrentSpan` in the handler.
- **`toHttpApi`, `toCli`, `toMcp` and `toToolkit` publish nothing without `expose`** (§One Api, every surface).
- **`layerDurableObjects` needs `SecureRandom`**: provide `SecureRandom.layerWebCrypto` (`effect/crypto`) after it, not beside it in one `Layer.mergeAll`.
- **Aggregate clients**: `state(target)` is renamed `get(target)`. `schedule` returns a `ScheduleReceipt` and cannot fail (scheduling again with the same `commandId` replaces the earlier one), so drop any `catchTag("AlreadyExecuted")` around it; `unschedule` still fails with `AlreadyExecuted`, `AlreadyCancelled` or `NotScheduled`.
- **Durable Object classes are renamed on the first deploy** with `renamedFrom`, keeping their data. Two models that shared a class fail with `DurableObjectRenameConflict` until all but one set `legacyData: false` on their `layer`.

## Gaps at beta.87

These are the reasons to stay hand-built today. Recheck them in the pinned source on every upgrade.

- **No approval before a write.** Tools carry fixed hints (reads read-only and idempotent, commands destructive), and the docs state that no approval step is wired from the Api yet. A command's middleware can demand a second factor (the upstream bank's `MfaChallenge`); keep destructive commands off an agent's Api.
- **Every MCP client lists every tool.** The Api still refuses each call it should, but `tools/list` is not filtered per caller.
- **Live reads stay on the typed client and HTTP.** `watch` and `events` are neither tools nor CLI commands.
- **The whole package is beta.** Nothing in it or its docs is marked experimental, so treat every API as equally movable: pin exactly, and reread the source after each upgrade.

## Testing

Stories for the model, Api tests for what each client sees, and a deploy test for the stack: [testing.md](testing.md).
