// The plugin's `commitments` and `follow_up` tools on a scratch SQLite record, given a token-shaped canary in every
// key and value of every call. Its own file: a simulated file has a 5 s CPU budget for all its seeds, and this test's
// 115 calls took commitments.sim.test.ts past it (5.1-5.2 s, measured in r5 and r6).
import { Effect } from "effect"
import { FOLLOW_UP } from "@dotfiles/opencode-orchestrate/commitments-tool"
import * as Seed from "../../sim/seed.ts"
import { scratch } from "../../tests/scratch.ts"
import { CANARY, COMMITMENT_CALLS, canariedFields, FOLLOW_UP_CALLS, mentions, textsOf } from "../../sim/canary.ts"
import { boot, WORK } from "./orch-tools-world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/canary.sim.test.ts")

const COMMITMENTS = "commitments"

// No refusal repeats what the caller wrote: a token-shaped canary as each key, value, id, path and referent of every
// action's call (sim/canary.ts) is in no tool result, no log line and no byte of the record's file.
seeded("a token-shaped canary in any key or value of any call is repeated by no answer, log line or record row", ({ seed, expect }) =>
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("commitments-canary-")),
    (dir) =>
      Effect.gen(function* () {
        const run = yield* boot(seed, true, { record: `${dir.path}/record.db` })
        const root = yield* run.world.session(WORK)
        const child = yield* run.world.session(WORK, { parentID: root })
        yield* run.probe(root, COMMITMENTS, { action: "add", source_kind: "plan-part", source_ref: "plan.md:1", parts: [{ id: "a1", title: "one" }, { id: "a2", title: "two" }] })
        const calls = [
          ...COMMITMENT_CALLS.flatMap((call) => canariedFields(call).map((input) => [root, COMMITMENTS, input] as const)),
          ...FOLLOW_UP_CALLS.flatMap((call) => canariedFields(call).map((input) => [child, FOLLOW_UP, input] as const)),
        ]
        const answers = yield* Effect.forEach(calls, ([session, tool, input]) => run.probe(session, tool, input))
        const files = yield* textsOf([`${dir.path}/record.db`, `${dir.path}/record.db-wal`])
        expect({
          calls: calls.length,
          unanswered: answers.filter((answer) => answer.text === "").length,
          answers: answers.filter((answer) => answer.text.includes(CANARY)).map((answer) => answer.text),
          logs: run.world.logs().filter(mentions),
          record: files.some((text) => text.includes(CANARY)),
        }).toEqual({ calls: 115, unanswered: 0, answers: [], logs: [], record: false })
        // The record was written (the canary-free calls took), so its bytes were there to search.
        expect(files.join("")).toContain("plan.md:1")
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ),
)
