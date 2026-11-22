// The `orchestrate` tool's runs on the simulated host (sim/world.ts): the real orchestrate plugin (sim/plugins.ts
// `orchestrate`), the real work plugin (cmd/work/server.ts `make`) on the work mod's memory layers and the real status
// plugin (sim/plugins.ts `status`, in the units' location), one copy of the others per location, over one memory world of warm sources, Rifts and
// unit logs. The units' logs are the world's files: the orchestrate plugin writes a unit's moves there, as log.ts does,
// and the status script prints them as its table, as status.ts does on disk. Each root turn is one `probe:` call; a
// subagent's task that ends `handback: <line>` answers that line. orch-tools.sim.test.ts and orch-tools-model.sim.test.ts drive it.
import { Array as Arr, Effect, Layer, Match, Option, Order, Schema } from "effect"
import type { Asked } from "@dotfiles/opencode-orchestrate/memory/fleet"
import type * as MemoryMainLine from "@dotfiles/opencode-orchestrate/memory/main-line"
import { lanePathOf } from "@dotfiles/opencode-orchestrate/tools"
import type * as MemoryRunFiles from "@dotfiles/opencode-orchestrate/memory/run-files"
import * as WorkGitTest from "@dotfiles/opencode-orchestrate/memory/work-git"
import * as MemoryDebts from "@dotfiles/opencode-work/memory/debts"
import * as MemoryLanding from "@dotfiles/opencode-work/memory/landing"
import * as MemoryNotices from "@dotfiles/opencode-work/memory/notices"
import * as MemoryRifts from "@dotfiles/opencode-work/memory/rifts"
import * as MemoryWorkbox from "@dotfiles/opencode-work/memory/workbox"
import { SessionDirectories, SessionUnreadable } from "@dotfiles/opencode-work/service"
import type { Workspace } from "@dotfiles/opencode-work/workspace"
import * as Plugins from "../../sim/plugins.ts"
import * as World from "../../sim/world.ts"
import { make as makeWork } from "../work/server.ts"

/** The warm source the run's roots work in. */
export const WORK = "/scratch/work"
/** A second warm source, of sessions that run no units. */
export const PLAIN = "/scratch/plain"
/** The plugin's fixed clock: a Wednesday afternoon. */
export const PIN = "2026-11-04T15:00:00Z"
/** A task whose last line is `handback: <line>` answers with that line first. */
export const HAND_BACK = "handback:"
/** A root turn that makes one given call: `probe:` and `{ name, input }` as JSON. */
export const PROBE = "probe:"
/** The commit origin's default branch names as the push left it: the memory landing's head of its last push. */
export const ORIGIN = "origin/HEAD"
/** The run the units' logs are in: `<WORK>/tmp/orchestrate/<RUN>/<unit>/log.md`. */
export const RUN = "lane"
const RUNS = `${WORK}/tmp/orchestrate`
export const RUN_DIR = `${RUNS}/${RUN}`
/** Where the status plugin finds the orchestrate skill's status script. */
const STATUS_SCRIPT = "/skills/orchestrate/scripts/status.ts"
/** When every log line was written: the pinned clock's minute. */
const SINCE = "2026-11-04T15:00Z"

const ProbeCall = Schema.fromJsonString(Schema.Struct({ name: Schema.String, input: Schema.Record(Schema.String, Schema.Json) }))
const decodeProbe = Schema.decodeUnknownOption(ProbeCall)
const encodeProbe = Schema.encodeSync(ProbeCall)

/** A call's input, as a probe sends it. */
export type Input = { readonly [key: string]: Schema.Json }

/** A unit's log as the world keeps it: the state its last move went to, and that move's round. */
export interface UnitLog {
  readonly state: string
  readonly round: number
}

/** A message's text as the model reads it. */
export const said = (message: World.Message): string => {
  switch (message.type) {
    case "user":
    case "synthetic":
    case "assistant":
      return message.text
    case "tool":
      return message.output
    case "compaction":
      return message.summary
    case "error":
      return message.message
    case "model-switched":
      return ""
  }
}

/** The fleet's checkouts the plugin is loaded with, and the fork's checked-out commit. */
export const FLEET = { dotfiles: "/scratch/dotfiles", fork: "/scratch/fork" }
/** FNV-1a of `text` from `seed`, as 8 hex. */
const fnv = (text: string, seed: number): string =>
  Arr.reduce(Array.from(text), seed >>> 0, (hash, char) => Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0)
    .toString(16)
    .padStart(8, "0")

/** A commit name for `what`: 40 hex, five FNV-1a hashes of it from different seeds, distinct in its first 7 for the world's names. */
export const shaFor = (what: string): string => [0x811c9dc5, 0x050c5d1f, 0x2166136a, 0x6b43a9b5, 0x1b873593].map((seed) => fnv(what, seed)).join("")

export const FORK_HEAD = shaFor("fork")

/** The head a unit's round-N request names, as its implementor's Rift had it. */
export const requestHeadFor = (unit: string, round: number): string => shaFor(`request ${unit} r${round}`)

/**
 * The default branch of the run's warm source, as its lands made it (memory/main-line.ts): a root commit, then one
 * merge per branch each pushed land merged, oldest first. A merge takes in the head of its unit's newest request, as
 * the run's files hold it when the land ran; the landing's push answers the push's last merge. A unit in `fastForward`
 * lands as a land fast-forwards: its branch's commits go onto the line, its request head last, and no merge. A merge
 * takes in the lane's head (`laneHeadOf`), as git's does the branch it merges.
 */
/** The head a test leaves a Rift at (MemoryRifts.clean's), which this world reads as the lane's own (`laneHeadOf`). */
const CLEAN_HEAD = MemoryRifts.clean("/lane", void 0).head

/** The newest request head of `unit` in the run's files, when it has one. */
const requestHeadOf = (files: MemoryRunFiles.Files, unit: string): Option.Option<string> => {
  const rounds = [...files.keys()].flatMap((path) => Option.toArray(Option.map(Option.fromNullishOr(new RegExp(`^${RUN_DIR}/${unit}/round-(\\d+)-request\\.md$`).exec(path)?.[1]), Number)))
  return Option.map(Arr.last(rounds.toSorted((a, b) => a - b)), (round) => requestHeadFor(unit, round))
}

/**
 * A lane's head as git would hold it: its newest request's head once one is written, else its own first commit, made
 * as the lane was (so a lane is never at the default branch's tip, and only a land puts its head on main).
 */
export const laneHeadOf = (files: MemoryRunFiles.Files, unit: string): string => Option.getOrElse(requestHeadOf(files, unit), () => shaFor(`lane ${unit}`))

const mainLineOf = (landing: MemoryLanding.World, files: MemoryRunFiles.Files, earlier: number, fastForward: ReadonlyArray<string>) => {
  const line: Array<MemoryMainLine.Entry> = [{ sha: shaFor("root"), subject: "root", merged: [] }]
  // The merges main held before the run: no unit of the run is in them.
  for (let n = 1; n <= earlier; n += 1) line.push({ sha: shaFor(`earlier ${n}`), subject: `Merge branch 'feat/earlier-${n}'`, merged: [shaFor(`earlier tip ${n}`)] })
  const pushes: Array<string> = []
  const read = { steps: 0, pending: Arr.empty<string>() }
  /** The newest request head of the unit a branch is named for (its last segment). */
  const headOf = (branch: string): ReadonlyArray<string> => Option.toArray(requestHeadOf(files, branch.split("/").at(-1) ?? branch))
  const sync = () => {
    for (const step of landing.steps.slice(read.steps)) {
      if (step.startsWith("start ")) read.pending = []
      if (step.startsWith("merge ")) read.pending.push(step.slice("merge ".length))
      if (step.startsWith("push ") && read.pending.length > 0) {
        for (const branch of read.pending) {
          const heads = headOf(branch)
          const fast = fastForward.includes(branch.split("/").at(-1) ?? branch) && heads.length > 0
          if (fast) line.push({ sha: shaFor(`commit ${line.length} ${branch}`), subject: `feat: ${branch}`, merged: [] }, ...heads.map((sha) => ({ sha, subject: `test: ${branch}`, merged: [] })))
          // A merge takes in the lane's head, as git's does the branch it merges.
          else line.push({ sha: shaFor(`merge ${line.length} ${branch}`), subject: `Merge branch '${branch}'`, merged: [laneHeadOf(files, branch.split("/").at(-1) ?? branch)] })
        }
        pushes.push(line.at(-1)?.sha ?? "")
        read.pending = []
      }
    }
    read.steps = landing.steps.length
    return line
  }
  return { line: sync, pushed: (push: number) => Option.getOrElse(Arr.get(pushes, push - 1), () => shaFor(`push ${push}`)) }
}

/**
 * The Rifts as the work plugin reads them, each lane at its head as git would hold it (`laneHeadOf`, by the lane's
 * name, its unit), unless a test placed it elsewhere: the map the memory world keeps, its reads re-headed.
 */
const headed = (lanes: Map<string, Workspace>, files: MemoryRunFiles.Files, tip: () => string): Map<string, Workspace> => {
  // A lane made now is at the default branch's tip, as git makes it from the base, until its head is first read (the
  // work plugin's inspect as it makes it, which `orchestrate lane` records as the lane's start); its implementor's
  // first commit (`laneHeadOf`) is there by any later read.
  const fresh = new Map<string, string>()
  const read = (path: string, workspace: Workspace): Workspace =>
    Match.value(workspace.head === CLEAN_HEAD && !workspace.source).pipe(
      Match.when(true, () =>
        Option.match(Option.fromUndefinedOr(fresh.get(path)), {
          onNone: () => ({ ...workspace, head: laneHeadOf(files, path.split("/").at(-1) ?? path) }),
          onSome: (start) =>
            Object.defineProperty({ ...workspace }, "head", {
              enumerable: true,
              get: () => {
                fresh.delete(path)
                return start
              },
            }),
        }),
      ),
      Match.orElse(() => workspace),
    )
  const own = lanes.get.bind(lanes)
  const set = lanes.set.bind(lanes)
  return Object.assign(lanes, {
    get: (path: string) => Option.getOrUndefined(Option.map(Option.fromUndefinedOr(own(path)), (workspace) => read(path, workspace))),
    set: (path: string, workspace: Workspace) => {
      if (!lanes.has(path) && workspace.head === CLEAN_HEAD && !workspace.source) fresh.set(path, tip())
      return set(path, workspace)
    },
  })
}

/** The memory world under every work plugin copy: the two warm sources, their Rifts, the landing, the debts. */
const riftWorldOf = (files: MemoryRunFiles.Files, earlier: number, fastForward: ReadonlyArray<string>) => {
  const landing = MemoryLanding.world({
    [WORK]: MemoryLanding.config("main", "bun run gate", "bun run accept"),
    [PLAIN]: MemoryLanding.config("main", "bun run gate", "bun run accept"),
  })
  const main = mainLineOf(landing, files, earlier, fastForward)
  // A push answers its last merge's commit, as the line holds it.
  landing.headOf = (push) => {
    main.line()
    return main.pushed(push)
  }
  const base = MemoryRifts.world([WORK, PLAIN])
  // `origin/HEAD` reads as the default branch's head, as `git rev-parse` reads it after a land; any other commit is itself.
  const rifts: MemoryRifts.World = {
    ...base,
    rifts: headed(base.rifts, files, () => Option.getOrElse(Option.map(Arr.last(main.line()), (entry) => entry.sha), () => "")),
    commitOf: (at) =>
      Option.some(
        Option.getOrElse(
          Option.flatMap(Option.liftPredicate(at, (commit) => commit === ORIGIN), () => Option.map(Arr.last(main.line()), (entry) => entry.sha)),
          () => at,
        ),
      ),
  }
  return { rifts, landing, debts: MemoryDebts.world(), main }
}

/** A tool's answer: its text, and whether it failed (a refusal, or the tool's own failure). */
export interface Answer {
  readonly text: string
  readonly error: boolean
}

/** A session's last tool answer after its message at `from`. */
const answerAfter = (messages: ReadonlyArray<World.Message>, from: number): Answer =>
  Option.getOrElse(
    Arr.findFirst(messages.slice(from).toReversed(), (message) =>
      Option.liftPredicate(message, (found) => found.type === "tool").pipe(Option.map((found): Answer => ({ text: said(found), error: found.type === "tool" && found.error }))),
    ),
    (): Answer => ({ text: "", error: true }),
  )

/** Whether a log's state closes its unit: status.ts leaves a merged or dropped unit out of its default table. */
export const isClosed = (log: UnitLog): boolean => /^(merged|dropped)\b/.test(log.state)

/** The status script's table for the logs, as status.ts prints it by default: one row per open unit, by name. */
export const tableOf = (logs: ReadonlyMap<string, UnitLog>): string =>
  [
    "| Unit | State | Round | Since | Cause | Verdict |",
    "| --- | --- | --- | --- | --- | --- |",
    ...[...logs]
      .filter(([, log]) => !isClosed(log))
      .toSorted(([a], [b]) => Order.String(a, b))
      .map(([unit, log]) => `| ${unit} | ${log.state} | ${log.round} | ${SINCE} | log.md |  |`),
    "",
  ].join("\n")

/** How the world boots: its clock and the models its host offers, and a root's model. */
export interface BootOptions {
  readonly now?: string
  readonly models?: ReadonlyArray<World.CatalogModel>
  /** The merges the default branch holds before the run (none by default). */
  readonly merges?: number
  /** The units whose land fast-forwards main (no merge commit); every other land merges. */
  readonly fastForward?: ReadonlyArray<string>
  /**
   * The copies load in the units' location last, so its copy answers each RPC: the simulated host keeps one handler per
   * id, the last registered, where the fork keeps one per location (core rpc.ts). Off by default: the plain copy last.
   */
  readonly unitsAnswer?: boolean
  /** The commitment record's file (`options.record`): a scratch file a restart keeps; memory, one per start, by default. */
  readonly record?: string
}

/** The work plugin's copies and the orchestrate plugin's, loaded in each of the world's locations (`orchestrate` off: the work plugin alone). */
export const boot = Effect.fn("OrchTools.boot")(function* (seed: number, orchestrate: boolean, options: BootOptions = {}) {
  const woken: Array<MemoryNotices.Woken> = []
  // The units' logs: written by the orchestrate plugin, as log.ts writes log.md; read by the status script.
  const logs = new Map<string, UnitLog>()
  const fleet: Array<Asked> = []
  // The runs' files (requests, findings, batch files), outside every plugin copy: a restart keeps them, as a disk does.
  const files: MemoryRunFiles.Files = new Map()
  const memory = riftWorldOf(files, options.merges ?? 0, options.fastForward ?? [])
  // The lanes' heads against main, their activity and the processes in them: every head on main until a test places it.
  const workGit = WorkGitTest.world()
  const calls = { count: 0 }
  /** The tool names the last request offered, as the registry listed them. */
  const offered: Array<string> = []
  const script: World.Script = (request) => {
    if (request.kind === "title") return World.say("Orchestrate run")
    offered.splice(0, offered.length, ...request.tools)
    if (request.kind === "compaction") return World.say("## Objective\n- sim summary")
    const messages = world.context(request.sessionID)
    const probed = messages.findLastIndex((message) => message.type === "user" && message.text.startsWith(PROBE))
    const asked = Option.flatMap(Option.liftPredicate(probed, (index) => index >= 0), (index) =>
      Option.flatMap(Arr.get(messages, index), (message) => decodeProbe(said(message).slice(PROBE.length))),
    )
    if (Option.isSome(asked)) {
      if (messages.slice(probed + 1).some((message) => message.type === "tool")) return World.say("probe done")
      calls.count += 1
      return World.call(`call_${calls.count}`, asked.value.name, asked.value.input)
    }
    // A subagent: the hand-back line of its task.
    const task = Option.getOrElse(Option.map(Arr.findFirst(world.messages(request.sessionID), (message) => message.type === "user"), said), () => "")
    const handBack = Arr.findFirst(task.split("\n"), (line) => Option.liftPredicate(line.trim(), (trimmed) => trimmed.startsWith(HAND_BACK)))
    return Option.match(handBack, {
      onNone: () => World.say("sim: nothing to do"),
      onSome: (line) => World.say(`${line.slice(HAND_BACK.length).trim()}\nThe gate is green.`),
    })
  }
  /** The run's folder and the status script over it, in the world's shell. */
  const processes = (command: string): World.Process => {
    // No run folder until a unit has a log: `ls` fails, as on a repository with none.
    if (command === `ls -1 ${RUNS}` && logs.size === 0) return { exitCode: 1, stdout: "", ms: 5 }
    if (command === `ls -1 ${RUNS}`) return { exitCode: 0, stdout: `${RUN}\n`, ms: 5 }
    if (command === `bun ${STATUS_SCRIPT} ${RUN_DIR}`) return { exitCode: 0, stdout: tableOf(logs), ms: 50 }
    return World.PROCESSES(command)
  }
  const made = { seed, start: Date.parse(options.now ?? PIN), script, processes }
  const world = World.make(Option.match(Option.fromUndefinedOr(options.models), { onNone: () => made, onSome: (models) => ({ ...made, models }) }))
  // A session's location, as OpenCode's `session.get` reports it.
  const directories = Layer.succeed(
    SessionDirectories,
    SessionDirectories.of({
      directoryOf: Effect.fn("OrchTools.directoryOf")(function* (sessionID: string) {
        const session = Option.fromUndefinedOr(world.sessions.get(sessionID))
        if (Option.isNone(session)) return yield* new SessionUnreadable({ sessionID, message: `no session ${sessionID}` })
        return session.value.directory
      }),
    }),
  )
  const work = makeWork(() =>
    Layer.mergeAll(
      MemoryRifts.layer(memory.rifts),
      directories,
      MemoryLanding.layer(memory.landing),
      MemoryNotices.layer(woken),
      MemoryWorkbox.layer(false),
      MemoryDebts.layer(memory.debts),
    ),
  )
  const plugin = Plugins.orchestrate({
    fleet,
    files,
    workGit,
    mainLine: (checkout) => Option.liftPredicate({ branch: "main", line: memory.main.line() }, () => checkout === WORK),
    refs: (checkout, rev) =>
      Option.orElse(Option.liftPredicate(FORK_HEAD, () => checkout === FLEET.fork && rev === "HEAD"), () =>
        Option.liftPredicate(rev, (sha) => checkout === FLEET.dotfiles && /^[0-9a-f]{40}$/.test(sha)),
      ),
    unitLogs: {
      find: ({ unit }) => Effect.succeed(`${RUN_DIR}/${unit}`),
      append: (dir, transition) => Effect.sync(() => void logs.set(dir.split("/").at(-1) ?? transition.unit, { state: transition.to, round: transition.round })),
    },
  })
  for (const directory of Match.value(options.unitsAnswer === true).pipe(Match.when(true, () => [PLAIN, WORK]), Match.orElse(() => [WORK, PLAIN]))) {
    if (orchestrate) yield* world.load(plugin, { directory, options: { now: options.now ?? PIN, fleet: FLEET, ...Option.match(Option.fromUndefinedOr(options.record), { onNone: () => ({}), onSome: (record) => ({ record }) }) } })
    yield* world.load(work, { directory, options: { workrift: false } })
  }
  // The status plugin in the units' location only: the simulated host keeps one RPC per id, the last copy registered,
  // and the status RPC answers the runs of its own copy's location.
  yield* world.load(Plugins.status(world), { directory: WORK, options: { statusScript: STATUS_SCRIPT } })
  const idle = (sessionID: string) => Option.exists(Option.fromUndefinedOr(world.sessions.get(sessionID)), (session) => !session.running && session.inbox.length === 0)
  /** Every session of the world is idle: no turn runs and none waits. */
  const settled = () => [...world.sessions.keys()].every(idle)
  /** One probe turn: the session makes that one call; its answer's text. */
  const probe = Effect.fn("OrchTools.probe")(function* (sessionID: string, name: string, input: Input) {
    const from = world.messages(sessionID).length
    yield* world.prompt(sessionID, `${PROBE}${encodeProbe({ name, input })}`)
    yield* world.until(() => idle(sessionID), 120_000)
    return answerAfter(world.messages(sessionID), from)
  })
  /** The children of a session, in the order made. */
  const children = (parent: string) => [...world.sessions.values()].filter((session) => Option.contains(session.parentID, parent))
  return { world, offered, logs, fleet, files, memory, workGit, woken, probe, idle, settled, children }
})

export type Run = Effect.Success<ReturnType<typeof boot>>

// ── What the suites that drive it share ──

export const ORCHESTRATE = "orchestrate"
const READY = "/nonexistent/loop-probe-x/request.md"
export const FINDINGS = "/nonexistent/loop-probe-x/batch-findings.md"

/** The workspace a lane's answer ends with: its `(lane: <path>)` (tools.ts `lanePathOf`, which takes the old `(rift: <path>)` too). */
export const suffixOf = (answer: string): string => Option.getOrElse(lanePathOf(answer), () => "")

/** The warning a land of a unit the logs show in another state than `ready` starts with. */
export const warningOf = (unit: string, state: string) => `orchestrate: warning: ${unit} is ${state}, not ready; landed as asked.`

/** The branches the land steps since `from` merged, in order. */
export const mergedSince = (run: Run, from: number) =>
  run.memory.landing.steps.slice(from).flatMap((step) => Option.toArray(Option.map(Option.liftPredicate(step, (found) => found.startsWith("merge ")), (found) => found.slice("merge ".length))))
export const startsOf = (run: Run) => run.memory.landing.steps.filter((step) => step.startsWith("start ")).length

/** The state a unit's log is in after its implementor hands back `verdict` (`none`: still implementing). */
export const stateOf = (verdict: "ready" | "blocked" | "none"): string => Match.value(verdict).pipe(Match.when("none", () => "implement"), Match.orElse((said) => said))

/** A prompt: `none` asks plainly, any other verdict ends with that hand-back line. */
export const promptOf = (verdict: string, plain: string, line: string): string => Match.value(verdict).pipe(Match.when("none", () => plain), Match.orElse(() => `${HAND_BACK} ${line}`))


/** An implementor's start in `root`, with its hand-back line (none for `none`), waited out until its hand-back is in the logs. */
export const implement = Effect.fn("OrchTools.implement")(function* (run: Run, root: string, unit: string, round: number, description: string, verdict: "ready" | "blocked" | "none") {
  // A ready implementor has written its round's request, naming its Rift's head, before it hands back.
  if (verdict === "ready") run.files.set(`${RUN_DIR}/${unit}/round-${round}-request.md`, { text: `Head: ${requestHeadFor(unit, round)}\n`, at: run.world.now() })
  const prompt = promptOf(verdict, "Work on it.", `implementor ${unit} r${round}: ${verdict} ${READY}`)
  const answer = yield* run.probe(root, "subagent", { agent: "implementor", description, prompt, background: true })
  yield* run.world.until(run.settled, 60_000)
  const expected = stateOf(verdict)
  if (!answer.error) yield* run.world.until(() => Option.exists(Option.fromUndefinedOr(run.logs.get(unit)), (log) => log.state === expected && log.round === round), 30_000)
  return answer
})

/** When the next findings are written: after every file before them, on the world's clock. */
export const stampOf = (run: Run): number => Math.max(run.world.now(), ...[...run.files.values()].map((file) => file.at + 1))
