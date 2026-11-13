// The ChatGPT backend's laws (chatgpt-laws.ts) on both backends: the fake the
// real tier keeps using (tests/fake-chatgpt.ts, on a loopback port) and the
// world's (chatgpt.ts, on the world's clock). Each law's report must be the
// same on both: the simulated backend answers no kinder than the fake.
import { Clock, Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { startFakeChatGPT } from "../tests/fake-chatgpt.ts"
import * as ChatGPT from "./chatgpt.ts"
import { CHATGPT_LAWS, type ChatGPTLaw, reading, type Wire } from "./chatgpt-laws.ts"
import { makeRuntime } from "./runtime.ts"
import * as Seed from "./seed.ts"
import { START } from "./world.ts"

/** One exchange with the fake over loopback: its answer, read whole. */
const overLoopback = (request: Request) =>
  HttpClient.execute(HttpClientRequest.fromWeb(request)).pipe(
    Effect.flatMap((answer) => answer.text.pipe(Effect.map((body) => new Response(body, { status: answer.status, headers: answer.headers })))),
    Effect.provide(FetchHttpClient.layer),
    Effect.orDie,
  )

/** The law on the fake, on a real port: its report. */
const onFake = (law: ChatGPTLaw) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const fake = startFakeChatGPT()
      for (const [id, account] of law.accounts(at)) fake.accounts.set(id, account)
      return { at, fake }
    }),
    ({ at, fake }) => law.run({ origin: fake.url, send: overLoopback }, reading(at)),
    ({ fake }) => Effect.promise(() => fake.stop()),
  )

/** The law on the world's backend: its report. */
const onWorld = (law: ChatGPTLaw, seed: number) =>
  Effect.gen(function* () {
    const runtime = makeRuntime({ seed, start: START, log: () => void 0, fired: () => void 0 })
    const backend = ChatGPT.make()
    for (const [id, account] of law.accounts(START)) backend.accounts.set(id, account)
    const wire: Wire = { origin: ChatGPT.ORIGIN, send: backend.handle }
    return yield* runtime.run(law.run(wire, reading(START)))
  })

const { seeded } = Seed.runner("sim/chatgpt-laws.test.ts")

for (const law of CHATGPT_LAWS)
  seeded(law.name, ({ seed, expect }) =>
    Effect.gen(function* () {
      const fake = yield* onFake(law)
      const world = yield* onWorld(law, seed)
      expect(world).toEqual(fake)
      expect(world.length).toBeGreaterThan(0)
    }),
  )
