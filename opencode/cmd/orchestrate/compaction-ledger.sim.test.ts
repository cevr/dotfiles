// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// A compacted root's note on the simulated host (sim/world.ts) at 20 seeds:
// the orchestrate, status, queue and wakes plugins are their composition
// roots on the world (sim/plugins.ts); the status script runs in the world's
// shell, and fails where a test says (as it did under the service binary
// before d747f2db); a fixture plugin compacts a session as the owner's
// /compact does (`session.compact`). The root starts an implementor of
// `alpha`, hears its hand-back and answers nothing, then compacts.
//
// - The run tables fail: the root is still told, with the error and the
//   units it started (before, it was told nothing).
// - The tables read: the note flags the implementor idle after a hand-back
//   no later call answered, and lists the root's queue item not done.
// - A subagent, and a root that started no unit's step, are told nothing.
import { Plugin } from "@opencode/plugin/effect"
import { SessionID } from "@opencode/schema/session-id"
import type { CallLine } from "@dotfiles/opencode-orchestrate/call-line"
import { DateTime, Effect, Option, Schema } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/compaction-ledger.sim.test.ts")

const WORK = "/scratch/project"
/** A Wednesday afternoon, so the Sabbath never holds a start. */
const PIN = "2026-11-04T15:00:00Z"
const STATUS_SCRIPT = "/skills/orchestrate/scripts/status.ts"
const TABLE = [
  "| Unit | State | Round | Since | Cause | Verdict |",
  "| ---- | ----- | ----- | ----- | ----- | ------- |",
  "| alpha | ready | 1 | 2026-11-04T15:00Z | round-1-request.md |  |",
  "",
].join("\n")
const BROKEN = "cannot read /scratch/project/tmp/orchestrate/p1"

/** The project's one run, and the status script over it: printing its table, or failing. */
const processes =
  (fails: boolean) =>
  (command: string): World.Process => {
    if (command === `ls -1 ${WORK}/tmp/orchestrate`) return { exitCode: 0, stdout: "p1\n", ms: 5 }
    if (command !== `bun ${STATUS_SCRIPT} ${WORK}/tmp/orchestrate/p1`) return World.PROCESSES(command)
    if (fails) return { exitCode: 1, stdout: BROKEN, ms: 50 }
    return { exitCode: 0, stdout: TABLE, ms: 50 }
  }

const IMPLEMENT = { agent: "implementor", description: "implementor alpha r1", prompt: "Implement alpha.", background: true }
const HAND_BACK = "implementor alpha r1: ready /scratch/project/tmp/orchestrate/p1/alpha/round-1-request.md"
const QUEUED = { set: [{ id: "land-alpha", text: "Land alpha", state: "next" }, { id: "old", text: "Old thing", state: "done" }] }
const STARTED = "Started alpha's implementor."
const HEARD = "Heard alpha's hand-back."
const AFTER = "after-compaction"
const NOTED = "Noted the run."
const CHAT = "just chatting"

/** The scenario's model, on the world's request text. */
const model: World.Script = (request) => {
  const s = request.text
  if (request.kind === "title") return World.say("Ledger fixture")
  if (request.kind === "compaction") return World.say("## Objective\n- sim summary")
  if (request.agent === "implementor") return World.say(`${HAND_BACK}\nGate green.`)
  if (s.endsWith(`user: ${AFTER}`)) return World.say(NOTED)
  if (s.endsWith(`user: ${CHAT}`)) return World.say("Hello.")
  if (s.includes(HAND_BACK)) return World.say(HEARD)
  if (!s.includes("call_queue")) return World.call("call_queue", "queue", QUEUED)
  if (!s.includes("call_start")) return World.call("call_start", "subagent", IMPLEMENT)
  return World.say(STARTED)
}

/** Compacts a session as the owner's /compact does: the fixture's one RPC method. */
const COMPACT = { id: "fixture.compact", methods: { compact: { input: { type: "object" }, output: { type: "object" } } }, events: {} } as const
const CompactInput = Schema.Struct({ sessionID: Schema.String })
const compactor = Plugin.define({
  id: "fixture.compact",
  effect: (ctx) =>
    ctx.rpc
      .register(COMPACT, {
        compact: (input) =>
          Schema.decodeUnknownEffect(CompactInput)(input).pipe(
            Effect.flatMap(({ sessionID }) => ctx.session.compact({ sessionID: SessionID.make(sessionID) })),
            Effect.as({}),
            Effect.orDie,
          ),
      })
      .pipe(Effect.orDie, Effect.asVoid),
})

/** The note the orchestrate plugin put in a session, as the session's next request carried it. */
const NOTE_HEAD = "Re-read ~/.claude/skills/orchestrate/SKILL.md"

/** One world: the root starts alpha's implementor, hears its hand-back, compacts, and is prompted again; a chatting root and the implementor compact too. */
const boot = (seed: number, fails: boolean, crowd = 0) =>
  Effect.gen(function* () {
    const world = World.make({ seed, start: Date.parse(PIN), script: model, processes: processes(fails) })
    const lines: Array<CallLine> = []
    yield* world.load(Plugins.orchestrate({ lines }), { directory: WORK, options: { now: PIN } })
    yield* world.load(Plugins.status(world), { directory: WORK, options: { statusScript: STATUS_SCRIPT } })
    yield* world.load(Plugins.queue(), { directory: WORK })
    yield* world.load(Plugins.wake(world), { directory: WORK })
    yield* world.load(compactor, { directory: WORK })
    const root = yield* world.session(WORK)
    const chat = yield* world.session(WORK)
    const said = (session: string, text: string) => world.messages(session).some((message) => message.type === "assistant" && message.text === text)

    yield* world.prompt(root, "go")
    yield* world.until(() => said(root, HEARD), 60_000)
    yield* world.advance(2_000)
    const child = [...world.sessions.values()].find((session) => Option.getOrUndefined(session.parentID) === root)?.id ?? ""
    // `crowd` later calls of the root, each to a worker of its own after the hand-back: none answers alpha's.
    for (const n of Array.from({ length: crowd }, (_, index) => index + 1)) {
      const at = DateTime.formatIso(DateTime.makeUnsafe(world.now() + n))
      lines.push({ kind: "call", at, sessionID: root, callID: `crowd_${n}`, from: "build", agent: "worker", reason: "kept", child: `ses_crowd${n}`, description: `check ${n}` })
    }

    yield* world.prompt(chat, CHAT)
    yield* world.until(() => said(chat, "Hello."), 60_000)

    for (const session of [root, chat, child]) {
      yield* world.rpc(COMPACT.id, "compact", { sessionID: session })
      yield* world.advance(25_000)
    }
    yield* world.prompt(root, AFTER)
    yield* world.until(() => said(root, NOTED), 60_000)
    /** The notes each session's context holds after its compaction. */
    const notes = (session: string) =>
      world
        .messages(session)
        .filter((message): message is Extract<World.Message, { readonly type: "synthetic" }> => message.type === "synthetic" && message.text.includes(NOTE_HEAD))
        .map((message) => message.text)
    return { root: notes(root), chat: notes(chat), child: notes(child), childID: child }
  })

seeded("run tables that fail still tell the compacted root, with the error and the units it started", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { root, chat, child } = yield* boot(seed, true)
    expect(root).toHaveLength(1)
    const note = root[0] ?? ""
    expect(note).toContain(`orchestrate: the run tables could not be read: ${STATUS_SCRIPT} failed: ${BROKEN}.`)
    expect(note).toContain("The units you started steps of: alpha.")
    expect(note).toContain("Your ledger, as it stood at the compaction:")
    // A subagent, and a root that started no step, are told nothing.
    expect(chat).toEqual([])
    expect(child).toEqual([])
  }),
)

seeded("the note is the ledger: the queue not done, and the implementor idle after a hand-back nothing answered", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { root, chat, child, childID } = yield* boot(seed, false)
    expect(root).toHaveLength(1)
    const note = root[0] ?? ""
    expect(note).toContain("orchestrate: run p1:\n- alpha: ready")
    expect(note).toContain("Queue, not done:\n- [next] Land alpha")
    expect(note).not.toContain("Old thing")
    expect(note).toMatch(
      new RegExp(
        `Subagents now:\\n- ${childID} \\(implementor alpha r1\\): idle since \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ, last said: ${HAND_BACK.replaceAll("/", "\\/")}, not woken since`,
      ),
    )
    expect(note).toContain("Wakes, monitors and jobs: none.")
    expect(chat).toEqual([])
    expect(child).toEqual([])
  }),
)

seeded("an unanswered hand-back older than 41 later subagent calls is still flagged; the answered and idle ones are not listed", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { root, childID } = yield* boot(seed, false, 41)
    expect(root).toHaveLength(1)
    const note = root[0] ?? ""
    expect(note).toContain(`- ${childID} (implementor alpha r1): idle since `)
    expect(note).toContain(`last said: ${HAND_BACK}, not woken since`)
    // The 41 workers never ran (no session the host can read): no line of theirs.
    expect(note).not.toContain("check 1")
  }),
)
