// The provider laws (provider-laws.ts) on both providers: the fake the real
// tier keeps using (tests/fake-anthropic.ts, on a loopback port) and the
// world's (provider.ts, on the world's clock). Each law's report must be the
// same on both: the simulated provider answers no kinder than the fake.
import { Clock, Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { fakeAccount, startFakeAnthropic } from "../tests/fake-anthropic.ts"
import { PROVIDER_LAWS, type ProviderLaw, reading, type Wire } from "./provider-laws.ts"
import * as Provider from "./provider.ts"
import { makeRuntime, record } from "./runtime.ts"
import * as Seed from "./seed.ts"
import { START } from "./world.ts"

/** Every token a wire's accounts have held, as `<name.kind.generation>`: a rotated token keeps its own name. */
const registry = (wire: Pick<Wire, "tokens">, names: ReadonlyArray<string>) => {
  const known = new Map<string, string>()
  return () => {
    for (const name of names) {
      const tokens = wire.tokens(name)
      const generation = [...known.values()].filter((label) => label.startsWith(`<${name}.access.`)).length
      if (!known.has(tokens.access)) known.set(tokens.access, `<${name}.access.${generation}>`)
      if (!known.has(tokens.refresh)) known.set(tokens.refresh, `<${name}.refresh.${generation}>`)
    }
    return [...known.entries()]
  }
}

const ok = (): Provider.Answer => ({ kind: "ok" })

/** One exchange with the fake over loopback: its answer, read whole. */
const overLoopback = (request: Request) =>
  HttpClient.execute(HttpClientRequest.fromWeb(request)).pipe(
    Effect.flatMap((answer) => answer.text.pipe(Effect.map((body) => new Response(body, { status: answer.status, headers: answer.headers })))),
    Effect.provide(FetchHttpClient.layer),
    Effect.orDie,
  )

/** The law on the fake, on a real port: its report. */
const onFake = (law: ProviderLaw) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const at = Math.ceil((yield* Clock.currentTimeMillis) / 1000) * 1000
      const accounts = Object.fromEntries(law.accounts.map((name) => [name, fakeAccount()] as const))
      const setup = law.setup(at)
      // The fake's clock held at the law's start, as the world's is: the times it answers are offsets from it.
      const fake = startFakeAnthropic({
        ...setup,
        accounts,
        now: () => at,
        script: (info) => (setup.script ?? ok)({ account: info.account ?? "", index: info.index, body: record(info.body) }),
      })
      return { at, fake }
    }),
    ({ at, fake }) => {
      const wire: Wire = { origin: fake.url, send: overLoopback, tokens: fake.tokens }
      return law.run(wire, reading(at, registry(wire, law.accounts)), at)
    },
    ({ fake }) => Effect.promise(() => fake.stop()),
  )

/** The law on the world's provider: its report. */
const onWorld = (law: ProviderLaw, seed: number) =>
  Effect.gen(function* () {
    const runtime = makeRuntime({ seed, start: START, log: () => void 0, fired: () => void 0 })
    const provider = Provider.make({ seed, accounts: Provider.accounts(seed, law.accounts), ...law.setup(START) }, runtime)
    const wire: Wire = { origin: Provider.ORIGIN, send: (request) => Effect.orDie(provider.handle(request)), tokens: provider.tokens }
    return yield* runtime.run(law.run(wire, reading(START, registry(wire, law.accounts)), START))
  })

const { seeded } = Seed.runner("sim/provider-laws.test.ts")

for (const law of PROVIDER_LAWS)
  seeded(law.name, ({ seed, expect }) =>
    Effect.gen(function* () {
      const fake = yield* onFake(law)
      const world = yield* onWorld(law, seed)
      expect(world).toEqual(fake)
      expect(world.length).toBeGreaterThan(0)
    }),
  )
