# Testing

Which test answers which question once Alchemy is involved, and our rules for each. Effect unit tests, fakes, clocks and fixtures belong to the `effect` skill (`references/TESTING.md`); this file covers domain models, Apis, deployed stacks, and Providers.

## Contents

- Pick the test
- Stories
- Api tests
- Stack tests
- Provider tests
- The `@alchemy.run/test` package

## Pick the test

| Question | Test | Lives in | Touches a cloud |
| --- | --- | --- | --- |
| Does the model enforce its rules? Events, replies, rejections, views, policy reactions, saga outcomes | A story | the domain package | no |
| Is the model declared correctly? | `Domain.verify(Model)` equals `[]` | the domain package | no |
| Can each kind of client do and see what it should, through its middleware? | An Api test over `Domain.InMemory` | beside the Worker's `cmd/` main | no |
| Do the routes of a hand-built app work? | A route test on local Layers (`HttpRouter.serve` with `BunHttpServer.layerTest`) | the app | no |
| Does the deployed stack boot, bind, and answer? | A stack test with `@alchemy.run/test` | the repo root | yes, or local emulators |
| Does a custom Provider create, update, replace, and delete? | `test.provider` | the provider's package | yes |

Behaviour lives in stories, because they are fast and they account for every outcome. Write one Api test per access rule, and keep each stack test to one end-to-end flow.

## Stories

A story is given / when / then over the real model, in memory. `Story.make(Model, { layer, stub })` from `@alchemy.run/domain/Story` returns a runner, and each test passes it steps (`Story.given`, `when`, `then`, `rejected`, `replied`, `view`, `call`, `succeed`, `fail`, `clock`, `saga`, and the rest). The steps, the coverage list, and examples are in the upstream skill's `references/testing.md` (see [domain.md](domain.md) §Build it from the upstream skill) and at https://alchemy.run/domain/testing-models. Our rules:

- **A passing story has accounted for every outcome.** It fails on any committed event, rejection, external call, or saga defect that no step asserts. Answer a failure by asserting the outcome or fixing the model, never by loosening the story.
- **The upstream "What to cover" list is our bar**: every command, policy, saga, and view, with each of the cases it names.
- **Stub the external systems the story should answer** (`stub: [FraudCheck]`). Provide a real adapter's Layer to assert its calls instead.
- **Run one test suite against every adapter of a port** (the vendor, the memory fake), so the fake cannot drift from the vendor.
- **Test a saga by its outcome**: the events its steps record on aggregates, and its `Story.saga` status. Its internal steps are not part of the contract.
- **Keep one test asserting `Domain.verify(Model)` is empty.**
- A story is an ordinary Effect, so it runs under the package's Effect test runner (`it.effect`). Upstream runs stories on `@effect/vitest`. A story hosts its own in-memory model, so `Domain.InMemory` belongs to Api tests only, and a story moves time with `Story.clock` or `Story.advance`.

## Api tests

Beside the Worker's `cmd/` main, host the model with `Model.layer(handlers)` over `Domain.InMemory`, add the real middleware Layers, and call the Api as a client would: `MyApi.clientInProcess` with a test-signed session, or a test HTTP server serving `yield* MyApi` and a client over `Domain.protocolHttp`. Each test that provides the Layer gets a fresh, empty model. Upstream runs these with `it.live`. The worked examples are at https://alchemy.run/domain/testing-apis.

## Stack tests

A stack test deploys the real `alchemy.run.ts` to a throwaway stage, drives it, and destroys it: the repeatable form of SKILL.md §Test on Real Infrastructure.

- **Make the stack stage-aware.** The harness deploys into `test_$USER` (`ALCHEMY_TEST_STAGE` or the `stage` option override it, for example one stage per pull request). Non-prod stages get their own project and a public URL, and skip custom domains and DNS.
- **Tie deploy and destroy to the test's scope** with `Effect.acquireRelease`. Upstream teaches `beforeAll(deploy(Stack))` and `afterAll(destroy(Stack))` from `Test.make`; `oxlint-plugin-effect`'s `no-test-lifecycle-hooks` flags every call named `beforeAll` or `afterAll`, these included. A scope also destroys the stage when the test fails.
- **One deployed scenario per file.** `destroy` also closes the harness's file-wide scope (`make` in `src/Bun.ts`).

```typescript
import * as Test from "@alchemy.run/test/Bun";
import Stack, { providers } from "../alchemy.run.js"; // export the providers Layer from the stack file

const { test, deploy, destroy } = Test.make({ providers, state: Alchemy.localState() });
const deployed = Effect.acquireRelease(deploy(Stack), () => destroy(Stack).pipe(Effect.orDie));

test("health", Effect.gen(function* () {
  const { url } = yield* deployed;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const res = yield* client.get(`${url}/health`).pipe(
    Effect.retry({ schedule: Schedule.exponential("1 second"), times: 8 }), // a fresh host 404s briefly
  );
  expect(yield* res.text).toBe("ok");
}).pipe(Effect.scoped), { timeout: 600_000 });
```

- `HttpClient` is in scope in every harness test. `Test.getWhenReady` retries only 404 and 5xx, but its error type is `unknown`, which trips tsgo's `anyUnknownInErrorContext`; write the bounded retry yourself as above.
- **A Durable Object busy through a redeploy can run the old code for up to 5 minutes.** Give the Worker `codeUpdateStrategy: { mode: "immediate" }` on test stages, or address a fresh object per test.
- **Drive a deployed domain backend through its Api's client** (`MyApi.client` over `Domain.protocolWebSocket` or `protocolHttp`), with a real sign-in. Stories already cover the rules; the stack test proves hosting, bindings, and the wire.
- Name the file outside Bun's test pattern (`tests/deploy.integration.ts`) and run it from a script (`"test:deploy": "bun test ./tests/deploy.integration.ts"`), so the gate never deploys. On Railway it takes about a minute: 40 s to deploy and 15 s to destroy.
- `Test.make({ dev: true })` runs the stack on the local emulators that `alchemy dev` uses (Cloudflare in workerd, AWS in Docker) and needs no cloud credentials; `ALCHEMY_DEV=1` turns it on without editing the file, and `ALCHEMY_TEST_DEV=1` forces it on for a whole suite. Railway has no emulator.

## Provider tests

`test.provider(name, (stack) => effect)` gives each test a scratch stack with private in-memory state. Call `stack.deploy(effect)` repeatedly with one logical ID to walk create, update, and replace, then `stack.destroy()`; the providers Layer is in scope for out-of-band SDK assertions. See https://alchemy.run/testing/testing-providers.

## The `@alchemy.run/test` package

beta.85 moved `Test.make` out of `alchemy/Test/*` into `@alchemy.run/test`. Add it at Alchemy's exact version (it peers on `alchemy` exactly). `Test.make` has one API on three runners; pick the adapter for the repo's runner:

| Import | Runner | `expect` from |
| --- | --- | --- |
| `@alchemy.run/test/Bun` | `bun test`, our default | `bun:test` |
| `@alchemy.run/test/Vitest` | Vitest; each test runs as `@effect/vitest`'s `it.live` | `@effect/vitest` |
| `@alchemy.run/test/Alchemy` | the `alchemy-test` binary: every file in one Bun process, tests in flight at once, logs under `.alchemy/log/test/` | `@alchemy.run/test` |

Reach for `alchemy-test` when a suite holds many slow deploy files. Its flags (`--stage`, `--profile`, `--tui`) are in `bunx alchemy-test --help`. Every `Test.make` option is typed in `MakeOptions` (`src/Core.ts`) and documented at https://alchemy.run/testing/test-harness.
