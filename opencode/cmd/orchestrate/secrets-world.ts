// The acceptance of the commitment record's one output boundary (mods/orchestrate/printable.ts) on the plugin's tools,
// shared by canary.sim.test.ts, canary-follow-up.sim.test.ts, secrets.sim.test.ts and secrets-follow-up.sim.test.ts
// (two files each: a simulated file has 5 s of CPU for all its seeds, and each test's 115 calls together took 5.0-5.2 s,
// measured in r6). Each way into a call that the canary of canary.sim.test.ts and canary-follow-up.sim.test.ts takes
// carries a secret of every kind the redactor knows, placed anywhere in its value (after text of any length, glued to
// a word, twice, inside JSON, encoded: sim/tokens.ts), one placement each, the seed moving which goes where. The
// leaks it finds: any answer, log line or record byte holding a fragment of LEAK_MIN characters of its secret.
import { Effect, Schema } from "effect"
import { FOLLOW_UP } from "@dotfiles/opencode-orchestrate/commitments-tool"
import { generator } from "../../sim/runtime.ts"
import { CANARY, canariedFields, type Fields, mentions, placedCalls, textsOf } from "../../sim/canary.ts"
import { LEAK_MIN, leaked, leakedFrom, windowsOf } from "../../sim/tokens.ts"
import { scratch } from "../../tests/scratch.ts"
import { boot, WORK } from "./orch-tools-world.ts"

const COMMITMENTS = "commitments"
const jsonOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** The printable runs of a text (a database's bytes are mostly pages of binary and the same rows again in the WAL), each once. */
const textRuns = (text: string): string => [...new Set(text.split(/[^\x21-\x7e]+/).filter((run) => run.length >= LEAK_MIN))].join("\n")

/** What one world of placed calls gave: how many, how many went unanswered, every leak and the record's bytes. */
export interface Placed {
  readonly calls: number
  readonly unanswered: number
  readonly leaks: ReadonlyArray<string>
  readonly written: boolean
}

/** What one world of canaried calls gave: how many, how many went unanswered, and where the canary was repeated. */
export interface Canaried {
  readonly calls: number
  readonly unanswered: number
  readonly answers: ReadonlyArray<string>
  readonly logs: ReadonlyArray<string>
  readonly record: boolean
  readonly written: boolean
}

/**
 * The root's `commitments` calls and the child's `follow_up` calls, the canary as each key and value of each
 * (sim/canary.ts), on a scratch record: the answers, log lines and record bytes that repeat it.
 */
export const canariedWorld = (seed: number, commitments: ReadonlyArray<Fields>, followUps: ReadonlyArray<Fields>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("commitments-canary-")),
    (dir) =>
      Effect.gen(function* () {
        const run = yield* boot(seed, true, { record: `${dir.path}/record.db` })
        const root = yield* run.world.session(WORK)
        const child = yield* run.world.session(WORK, { parentID: root })
        yield* run.probe(root, COMMITMENTS, { action: "add", source_kind: "plan-part", source_ref: "plan.md:1", parts: [{ id: "a1", title: "one" }, { id: "a2", title: "two" }] })
        const calls = [
          ...commitments.flatMap((call) => canariedFields(call).map((input) => [root, COMMITMENTS, input] as const)),
          ...followUps.flatMap((call) => canariedFields(call).map((input) => [child, FOLLOW_UP, input] as const)),
        ]
        const answers = yield* Effect.forEach(calls, ([session, tool, input]) => run.probe(session, tool, input))
        const files = yield* textsOf([`${dir.path}/record.db`, `${dir.path}/record.db-wal`])
        return {
          calls: calls.length,
          unanswered: answers.filter((answer) => answer.text === "").length,
          answers: answers.filter((answer) => answer.text.includes(CANARY)).map((answer) => answer.text),
          logs: run.world.logs().filter(mentions).map((line) => jsonOf(line)),
          record: files.some((text) => text.includes(CANARY)),
          // The record was written (the canary-free calls took), so its bytes were there to search.
          written: files.join("").includes("plan.md:1"),
        } satisfies Canaried
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  )

/** The root's `commitments` calls and the child's `follow_up` calls, each way placed with a secret, on a scratch record. */
export const placedWorld = (seed: number, commitments: ReadonlyArray<Fields>, followUps: ReadonlyArray<Fields>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("commitments-placed-")),
    (dir) =>
      Effect.gen(function* () {
        const run = yield* boot(seed, true, { record: `${dir.path}/record.db` })
        const root = yield* run.world.session(WORK)
        const child = yield* run.world.session(WORK, { parentID: root })
        yield* run.probe(root, COMMITMENTS, { action: "add", source_kind: "plan-part", source_ref: "plan.md:1", parts: [{ id: "a1", title: "one" }, { id: "a2", title: "two" }] })
        const random = generator(seed)
        const calls = [
          ...placedCalls(commitments, random).map(([input, name, placed]) => [root, COMMITMENTS, input, name, placed] as const),
          ...placedCalls(followUps, random, 1000).map(([input, name, placed]) => [child, FOLLOW_UP, input, name, placed] as const),
        ]
        const answers = yield* Effect.forEach(calls, ([session, tool, input]) => run.probe(session, tool, input))
        const files = (yield* textsOf([`${dir.path}/record.db`, `${dir.path}/record.db-wal`])).join("")
        const written = windowsOf(textRuns(`${jsonOf(run.world.logs())}\n${files}`))
        const leaks = calls.flatMap(([, tool, , name, placed], at) =>
          [
            ...leaked(answers[at].text, placed).map((fragment) => `answer of ${tool} (${name}): ${fragment}`),
            ...leakedFrom(written, placed).map((fragment) => `log or record (${name}): ${fragment}`),
          ].slice(0, 1),
        )
        // The record was written (the secret-free calls took), so its bytes were there to search.
        return { calls: calls.length, unanswered: answers.filter((answer) => answer.text === "").length, leaks, written: files.includes("plan.md:1") } satisfies Placed
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  )
