// The acceptance of the commitment record's one output boundary (mods/orchestrate/printable.ts) on the plugin's tools:
// each way into a call that commitments.sim.test.ts's canary takes carries a secret of every kind the redactor knows,
// placed anywhere in its value (after text of any length, glued to a word, twice, inside JSON, encoded: sim/tokens.ts),
// one placement each, the seed moving which goes where. No answer, log line or record byte holds a fragment of
// LEAK_MIN characters of its secret.
import { Effect, Schema } from "effect"
import { FOLLOW_UP } from "@dotfiles/opencode-orchestrate/commitments-tool"
import * as Seed from "../../sim/seed.ts"
import { generator } from "../../sim/runtime.ts"
import { COMMITMENT_CALLS, FOLLOW_UP_CALLS, placedCalls, textsOf } from "../../sim/canary.ts"
import { LEAK_MIN, leaked, leakedFrom, windowsOf } from "../../sim/tokens.ts"
import { scratch } from "../../tests/scratch.ts"
import { boot, WORK } from "./orch-tools-world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/secrets.sim.test.ts")

const COMMITMENTS = "commitments"
const jsonOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
/** The printable runs of a text (a database's bytes are mostly pages of binary and the same rows again in the WAL), each once. */
const textRuns = (text: string): string => [...new Set(text.split(/[^\x21-\x7e]+/).filter((run) => run.length >= LEAK_MIN))].join("\n")

seeded("a secret of any kind at any place in any key or value leaves no fragment in an answer, a log line or the record", ({ seed, expect }) =>
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
          ...placedCalls(COMMITMENT_CALLS, random).map(([input, name, placed]) => [root, COMMITMENTS, input, name, placed] as const),
          ...placedCalls(FOLLOW_UP_CALLS, random, 1000).map(([input, name, placed]) => [child, FOLLOW_UP, input, name, placed] as const),
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
        expect({ calls: calls.length, unanswered: answers.filter((answer) => answer.text === "").length, leaks }).toEqual({ calls: 115, unanswered: 0, leaks: [] })
        // The record was written (the secret-free calls took), so its bytes were there to search.
        expect(files).toContain("plan.md:1")
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ),
)
