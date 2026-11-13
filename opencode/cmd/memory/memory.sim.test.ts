// The memory plugin on the simulated host at 20 seeds: tests/memory.test.ts's
// names and claims, moved off real OpenCode. The plugin runs from its
// composition root (`make(liveWith(files))`), its memory file one of the
// host's files held in memory (mods/memory/memory/files.ts, which keeps the
// NoteStore laws), and the CLI reads the same file by its path. The scripted
// model is tests/memory/sim.ts's: the same tasks, tool calls and inputs.
//
// The host's side is pinned by the law `LAW.system` (sim/host-laws.ts): the
// context hook runs on each primary request's system prompt, a part it adds
// reaches the model, a title request runs none, and a location's sessions
// share one project.
import { Array as Arr, Effect, Option, Schema } from "effect"
import * as MemoryFiles from "@dotfiles/opencode-memory/memory/files"
import { AGAIN_TASK, DEPLOY, DEPLOY_FIXED, DONE, LATE, RECALL_TASK, REPEAT, type Reply, SAVE_TASK, SCRIPTS, STRINGS_TASK } from "../../tests/memory/sim.ts"
import { main } from "./cli.ts"
import { liveWith, make } from "./server.ts"
import { plain } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/memory/memory.sim.test.ts")

/**
 * The scripted model of tests/memory/sim.ts on the world: a request's task is its first prompt; each next tool call
 * comes once the last one's result is back, then `DONE`. It keeps each task's system prompts, one per request; a
 * title request gets a title and is not kept.
 */
const script = () => {
  const systems: Record<string, Array<string>> = {}
  const counter = { calls: 0 }
  const reply = (request: World.Request): World.Reply => {
    if (request.kind !== "primary") return World.say("Memory run")
    const lines = request.text.split("\n")
    const task = (lines.find((line) => line.startsWith("user: ")) ?? "").slice("user: ".length).trim()
    const name = Option.fromNullishOr(Object.keys(SCRIPTS).find((key) => task.endsWith(key)))
    if (Option.isNone(name)) return World.say("sim: nothing to do")
    systems[name.value] = [...(systems[name.value] ?? []), request.system]
    const next = Arr.get(SCRIPTS[name.value] ?? [], lines.filter((line) => line.startsWith("tool ")).length)
    return Option.match(
      Option.filter(next, (reply): reply is Extract<Reply, { readonly kind: "tool" }> => reply.kind === "tool"),
      {
        onNone: () => World.say(DONE),
        onSome: (reply) => {
          counter.calls += 1
          return World.call(`call_${counter.calls}`, reply.name, plain(reply.input))
        },
      },
    )
  }
  return { reply, systems }
}

/** The CLI's `stats --json`: the total and each note's stats, every field kept. */
const decodeAudit = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ total: Schema.Number, notes: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) })),
)

const WORK = "/scratch/work"
/** The memory file, as the real run names it in the plugin's options. */
const DB = "/scratch/state/memory.db"
/** How long the real run gave OpenCode for each session. */
const RUN_LIMIT_MS = 120_000

/** One run: the tasks, one root session each, in order, on one world with the memory plugin on `files`. */
const run = (seed: number, tasks: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const files = yield* MemoryFiles.make
    const scripted = script()
    const world = World.make({ seed, script: scripted.reply })
    yield* world.load(make(liveWith(files.files)), { directory: WORK, options: { path: DB } })
    const sessions = new Map<string, string>()
    for (const task of tasks) {
      const session = yield* world.session(WORK)
      sessions.set(task, session)
      yield* world.prompt(session, task)
      yield* world.until(() => world.sessions.get(session)?.running === false, RUN_LIMIT_MS)
    }
    /** The task's tool answers, in order: what each said, and whether it was an error. */
    const tools = (task: string) =>
      world.messages(sessions.get(task) ?? "").flatMap((message) => {
        if (message.type !== "tool") return []
        return [{ said: message.output, error: message.error }]
      })
    /** The task's session's last message. */
    const last = (task: string) => world.messages(sessions.get(task) ?? "").at(-1)
    // The CLI, as the owner runs it after the sessions: on the same host's files, at the world's time.
    const stats = yield* Effect.promise(() => main(["stats", "--json"], { db: DB, now: world.now(), files: files.files }))
    return { tools, last, systems: scripted.systems, stats, paths: files.paths() }
  }).pipe(Effect.scoped)

seeded("a note saved and repeated is one note; the next session starts with it, the same on every request; the CLI reads it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const result = yield* run(seed, [SAVE_TASK, RECALL_TASK, AGAIN_TASK])

    const [saved, repeated, searched, ...rest] = result.tools(SAVE_TASK)
    expect(rest).toEqual([])
    expect(saved?.said).toBe("Saved #1 (global).")
    expect(repeated?.said).toStartWith("Updated #1 (global), which said nearly the same")
    expect(searched?.said).toContain(`#1 [global] ${REPEAT} [bun]`)

    // The first session had no notes when it started: no memory block, on any of its requests.
    expect(result.systems[SAVE_TASK]?.length).toBe(4)
    for (const system of result.systems[SAVE_TASK] ?? []) expect(system).not.toContain("# Memory")

    // The second starts with the note, and its own save mid-session leaves its system prompt unchanged.
    const recall = result.systems[RECALL_TASK] ?? []
    expect(recall).toHaveLength(2)
    expect(recall[0]).toContain(`# Memory`)
    expect(recall[0]).toContain(`- #1 ${REPEAT} [bun]`)
    expect(recall[1]).toBe(recall[0]!)
    expect(recall[0]).not.toContain(LATE)
    expect(result.tools(RECALL_TASK)[0]?.said).toBe("Saved #2 (project).")

    // The third sees both.
    const again = result.systems[AGAIN_TASK]?.[0] ?? ""
    expect(again).toContain(`- #1 ${REPEAT}`)
    expect(again).toContain(`- #2 ${LATE}`)

    // The CLI reads the plugin's file: two notes, the global one found by the search, the first shown in two digests.
    expect(result.stats.code).toBe(0)
    const audit = decodeAudit(result.stats.out)
    expect(audit.total).toBe(2)
    expect(audit.notes[0]).toMatchObject({ id: 1, scope: "global", uses: 2, shown: 2 })
    expect(audit.notes[1]).toMatchObject({ id: 2, scope: "project", shown: 1 })

    // One file, the one the options name; each session ran to the model's last answer.
    expect(result.paths).toEqual([DB])
    for (const task of [SAVE_TASK, RECALL_TASK, AGAIN_TASK]) expect(result.last(task)).toMatchObject({ type: "assistant", text: DONE })
  }),
)

seeded("an id, a limit and tags sent as strings are read as the number and the list; a word for an id is refused", ({ seed, expect }) =>
  Effect.gen(function* () {
    const result = yield* run(seed, [STRINGS_TASK])
    const [saved, corrected, searched, forgot, refused, ...rest] = result.tools(STRINGS_TASK)
    expect(rest).toEqual([])
    expect(saved?.said).toBe("Saved #1 (project).")
    expect(corrected?.said).toBe(`Corrected #1 (project); it said: "${DEPLOY}".`)
    expect(searched?.said).toContain(`#1 [project] ${DEPLOY_FIXED} [deploy, release]`)
    expect(forgot?.error).toBe(false)
    expect(forgot?.said).toBe(`Forgot #1: "${DEPLOY_FIXED}".`)
    // Refused by the tool's own input schema, before the plugin's handler: the host's words for it stay real
    // (tests/memory.test.ts), as no law pins them yet.
    expect(refused?.error).toBe(true)
    expect(refused?.said).toContain("memory_forget")

    expect(decodeAudit(result.stats.out).total).toBe(0)
  }),
)
