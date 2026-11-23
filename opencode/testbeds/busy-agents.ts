// Agents at work in real OpenCode, for the end-to-end tests: sessions whose
// turns the fake Anthropic answers with a long command (`working`), so each
// session stays busy for minutes with no start recorded, as an agent run of
// hours does. The fork's client is found at run time, so it is typed here.
import { Data, Effect, Option, Schedule } from "effect"
import { answersTool, type FakeAnswer, type FakeRequestInfo, offeredTool, type ReceivedRequest } from "../tests/fake-anthropic.ts"

/** What the fake did not come to see within the wait. */
class NotSeen extends Data.TaggedError("NotSeen")<{ readonly message: string }> {}

/** What an agent runs: a command that keeps its session busy for minutes, waited on to its end. */
export const WORK_COMMAND = { command: "sleep 150", timeout: 0, description: "agent work" }

/** The fake's answers: an agent turn offering the shell, with no tool result yet, runs WORK_COMMAND; any other is answered in text. */
export const working = ({ body }: FakeRequestInfo): FakeAnswer =>
  Option.match(
    Option.filter(Option.fromUndefinedOr(offeredTool(body, "shell")), () => !answersTool(body)),
    {
      onNone: (): FakeAnswer => ({ kind: "ok" }),
      onSome: (shell): FakeAnswer => ({ kind: "ok", tool: { name: shell, input: WORK_COMMAND } }),
    },
  )

/** As much of the fork's client as this uses. */
interface ClientModule {
  readonly OpenCode: {
    readonly make: (options: { baseUrl: string; headers: { readonly authorization: string } }) => {
      readonly session: {
        readonly create: (input: { title: string; location: { directory: string } }) => Promise<{ readonly id: string }>
        readonly prompt: (input: { sessionID: string; text: string }) => Promise<object>
      }
    }
  }
}

const clientOf = (fork: string): Promise<ClientModule> => import(externalInput(`${fork}/packages/client/src/promise/index.ts`))

/** How long the fake has to see what is waited for: a minute, looked at every 250 ms. */
const WAIT = { schedule: Schedule.spaced("250 millis"), times: 240 }

/** Waits until `count` of the fake's requests holds `at least`; fails with `label` past a minute. */
const awaitCount = (count: () => number, least: number, label: () => string) =>
  Effect.sync(count).pipe(
    Effect.filterOrFail(
      (seen) => seen >= least,
      () => new NotSeen({ message: `${label()}: ${count()} of ${least}` }),
    ),
    Effect.retry(WAIT),
    Effect.asVoid,
  )

export interface Work {
  readonly fork: string
  readonly url: string
  readonly authorization: string
  readonly directory: string
  readonly received: ReadonlyArray<ReceivedRequest>
  /** How many agents to put to work. */
  readonly count: number
  /** First, how many usage reads the pool makes again (of quotas just set). */
  readonly reads: number
  /** The server's stderr, for a failure. */
  readonly log: () => string
}

/**
 * Puts `count` agents to work, each in a session of its own, once the pool
 * read the usage `reads` times again; resolves once the fake has seen each
 * agent's turn.
 */
export const putToWork = (work: Work): Promise<void> => {
  const seen = (path: string) => work.received.filter((request) => request.path === path && (path !== "/v1/messages" || request.tools > 0)).length
  const reads = seen("/api/oauth/usage")
  const turns = seen("/v1/messages")
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* awaitCount(() => seen("/api/oauth/usage"), reads + work.reads, () => `the pool's usage reads (${work.log()})`)
      const module = yield* Effect.promise(() => clientOf(work.fork))
      const client = module.OpenCode.make({ baseUrl: work.url, headers: { authorization: work.authorization } })
      for (let agent = 0; agent < work.count; agent++) {
        const session = yield* Effect.promise(() => client.session.create({ title: `agent ${agent}`, location: { directory: work.directory } }))
        yield* Effect.promise(() => client.session.prompt({ sessionID: session.id, text: "work" }))
      }
      yield* awaitCount(() => seen("/v1/messages"), turns + work.count, () => `the agents' turns (${work.log()})`)
    }),
  )
}
import { externalInput } from "../tests/read-path.ts"
