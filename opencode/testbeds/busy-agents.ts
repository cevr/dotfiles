// Agents at work in real OpenCode, for the end-to-end tests: sessions whose
// turns the fake Anthropic answers with a long command (`working`), so each
// session stays busy for minutes with no start recorded, as an agent run of
// hours does. The fork's client is found at run time, so it is typed here.
import { Data, Effect, Option, Schedule } from "effect"
import { answersTool, type FakeAnswer, type FakeRequestInfo, offeredTool, type ReceivedRequest } from "../tests/fake-anthropic.ts"
import { hangGuard } from "../tests/hang-guard.ts"

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
        readonly create: (input: { id?: string; parentID?: string; agent?: string; title: string; location: { directory: string } }) => Promise<{ readonly id: string }>
        readonly prompt: (input: { sessionID: string; text: string }) => Promise<object>
      }
    }
  }
}

const clientOf = (fork: string): Promise<ClientModule> => import(externalInput(`${fork}/packages/client/src/promise/index.ts`))

/** Wait on the reported count, not on elapsed time. The named cap only diagnoses a hung fixture. */
const awaitCount = (count: Effect.Effect<number>, least: number, label: () => string) =>
  Effect.gen(function* () {
    let seen = 0
    yield* count.pipe(
      Effect.tap((value) => Effect.sync(() => { seen = value })),
      Effect.filterOrFail((value) => value >= least, () => new NotSeen({ message: "the fixture is not ready" })),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
      Effect.timeoutOrElse({
        duration: hangGuard("process-fixture"),
        orElse: () => Effect.fail(new NotSeen({ message: `${label()}: ${seen} of ${least}` })),
      }),
    )
  })

export interface Work {
  readonly fork: string
  readonly url: string
  readonly authorization: string
  readonly directory: string
  /** All work belongs to one owner, so notices reach it regardless of which child asked for pace last. */
  readonly owner: string
  readonly received: ReadonlyArray<ReceivedRequest>
  /** How many of these Claude sessions the pool reports running. */
  readonly running: Effect.Effect<number>
  /** How many agents to put to work. */
  readonly count: number
  /** First, how many usage reads the pool makes again (of quotas just set). */
  readonly reads: number
  /** The server's stderr, for a failure. */
  readonly log: () => string
}

/**
 * Puts `count` agents to work, each in a session of its own, once the pool
 * read the usage `reads` times again; resolves when the pool reports the
 * turns running.
 */
export const putToWork = (work: Work): Promise<void> => {
  const seen = () => work.received.filter((request) => request.path === "/api/oauth/usage").length
  const reads = seen()
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* awaitCount(Effect.sync(seen), reads + work.reads, () => `the pool's usage reads (${work.log()})`)
      const module = yield* Effect.promise(() => clientOf(work.fork))
      const client = module.OpenCode.make({ baseUrl: work.url, headers: { authorization: work.authorization } })
      const location = { directory: work.directory }
      const owner = yield* Effect.promise(() => client.session.create({ id: work.owner, title: "Reset notice owner", location }))
      for (let agent = 0; agent < work.count; agent++) {
        const session = yield* Effect.promise(() => client.session.create({ parentID: owner.id, agent: "build", title: `agent ${agent}`, location }))
        yield* Effect.promise(() => client.session.prompt({ sessionID: session.id, text: "work" }))
      }
      yield* awaitCount(work.running, work.count, () => `the pool reporting Claude sessions running; fake turns: ${work.received.filter((request) => request.path === "/v1/messages").map((request) => `${request.model}:${request.tools}:${request.status}`).join(", ")} (${work.log()})`)
    }),
  )
}
import { externalInput } from "../tests/read-path.ts"
