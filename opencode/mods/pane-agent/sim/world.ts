import { Data, Effect, Option, Ref } from "effect"
import { DONE_FRAME, PERMISSION_FRAME, READY_FRAME, SIGNIN_FRAME, TRUST_FRAME, WORKING_FRAME } from "../agy.fixture.ts"
import type { SplitRightInput, WakeLetter } from "../service.ts"
import type { PaneWorker, StoreSnapshot } from "../worker.ts"

/** What a pane shows: the agent's own states and the three prompt kinds, the usage limit and an exited process. */
export type ScreenKind = "ready" | "working" | "done" | "trust" | "permission" | "prompt" | "limit" | "exited"

export const PROMPT_SCREENS: ReadonlyArray<ScreenKind> = ["trust", "permission", "prompt"]

/** How the agent hands back a turn's answer: none, a partial placeholder before the final file, final, or a stale old file. */
export type FileMode = "none" | "partial" | "final" | "stale"

export const PLACEHOLDER = "scratch"
export const STALE_CONTENT = "STALE-ANSWER-FROM-AN-EARLIER-RUN"
export const TOKEN = /\bTK-[a-z0-9]+-\d+\b/
export const answerOf = (token: string): string => `ANSWER-${token}`

export interface Run {
  readonly id: number
  readonly blockId: string
  readonly brief: string
  readonly token: Option.Option<string>
  readonly human: boolean
  readonly resultFile: Option.Option<string>
  readonly fileMode: FileMode
  readonly startedAt: number
  readonly endsAt: number
  readonly permissionAt: Option.Option<number>
  readonly endedAt: Option.Option<number>
  readonly interrupted: boolean
  readonly limited: boolean
  /** When a limited run's quota resets (the sign-in's reset); none for a run that was not limited. */
  readonly resetAt: Option.Option<number>
}

export interface Pane {
  readonly sessionId: string
  readonly blockId: string
  readonly label: string
  readonly command: ReadonlyArray<string>
  readonly cwd: string
  readonly owned: boolean
  readonly alive: boolean
  readonly closed: boolean
  readonly screen: ScreenKind
  readonly input: string
  readonly queue: ReadonlyArray<string>
  readonly current: Option.Option<number>
  readonly lastPrompt: string
  readonly lastAnswer: string
  readonly nextStartAt: Option.Option<number>
}

export interface WriteRecord {
  readonly at: number
  readonly proc: number
  readonly blockId: string
  readonly data: string
  readonly screen: ScreenKind
  readonly owned: boolean
}

export interface SplitRecord {
  readonly at: number
  readonly proc: number
  readonly blockId: string
  readonly input: SplitRightInput
}

export interface CloseRecord {
  readonly at: number
  readonly proc: number
  readonly blockId: string
  readonly owned: boolean
}

export interface WakeRecord {
  readonly at: number
  readonly proc: number
  readonly sessionID: string
  readonly letter: WakeLetter
}

export interface StoreWrite {
  readonly at: number
  readonly proc: number
  readonly worker: PaneWorker
}

export interface FileEntry {
  readonly content: string
  readonly mtimeMs: number
}

/**
 * Deliberately broken doubles, used only to show each invariant can fail (non-vacuity): a notifier that
 * drops done wakes, a pane that shows ready over a prompt, a pane reported gone while alive, a store that
 * drops options, a store that refuses or never answers late writes and reads, a pane that logs every write
 * twice (an echo), a pane that logs its first paste late (out of order), an agent whose `continue` after a
 * usage limit starts a fresh run that lost the turn's token.
 */
export type Break =
  | "drop-done-wakes"
  | "ready-over-prompt"
  | "gone-when-alive"
  | "drop-options"
  | "refuse-late-writes"
  | "hang-late-reads"
  | "echo-writes"
  | "late-stamp-first-paste"
  | "continue-loses-token"

/** How long the quota frame says the limit lasts ("Resets in 0h0m1s"). */
export const LIMIT_MS = 1_000
/** How far in the future the broken "late-stamp-first-paste" pane logs its first paste. */
export const LATE_STAMP_MS = 10_000

export interface WorldConfig {
  readonly workMs: number
  readonly queueGapMs: number
  readonly splitScreens: ReadonlyArray<ScreenKind>
  readonly fileModes: ReadonlyArray<FileMode>
  readonly permissionRuns: ReadonlyArray<number>
  readonly limitRuns: ReadonlyArray<number>
  readonly breaks: ReadonlyArray<Break>
}

export const DEFAULT_WORLD: WorldConfig = {
  workMs: 60,
  queueGapMs: 15,
  splitScreens: [],
  fileModes: [],
  permissionRuns: [],
  limitRuns: [],
  breaks: [],
}

export interface WorldState {
  readonly now: number
  readonly config: WorldConfig
  readonly nextBlock: number
  readonly panes: ReadonlyArray<Pane>
  readonly runs: ReadonlyArray<Run>
  readonly files: ReadonlyMap<string, FileEntry>
  readonly store: StoreSnapshot
  readonly writes: ReadonlyArray<WriteRecord>
  readonly splits: ReadonlyArray<SplitRecord>
  readonly closes: ReadonlyArray<CloseRecord>
  readonly wakes: ReadonlyArray<WakeRecord>
  readonly storeWrites: ReadonlyArray<StoreWrite>
  readonly deadProcs: ReadonlySet<number>
  readonly splitCount: number
  readonly deaths: ReadonlyArray<{ readonly blockId: string; readonly at: number }>
  /** Every pane shares one sign-in: until this moment its quota is spent, and every run ends at the limit. */
  readonly limitUntil: number
}

export const ANCHOR = { session: "session:root", block: "block:anchor" } as const
export const OWNER_BLOCK = "block:owner-named"

const ownerPane = (blockId: string, screen: ScreenKind): Pane => ({
  sessionId: ANCHOR.session,
  blockId,
  label: "owner",
  command: [],
  cwd: "/owner",
  owned: false,
  alive: true,
  closed: false,
  screen,
  input: "",
  queue: [],
  current: Option.none(),
  lastPrompt: "",
  lastAnswer: "",
  nextStartAt: Option.none(),
})

export const initialWorld = (config: WorldConfig): WorldState => ({
  now: 0,
  config,
  nextBlock: 1,
  panes: [ownerPane(ANCHOR.block, "ready"), ownerPane(OWNER_BLOCK, "ready")],
  runs: [],
  files: new Map(),
  store: { version: 2, workers: [], anchors: {} },
  writes: [],
  splits: [],
  closes: [],
  wakes: [],
  storeWrites: [],
  deadProcs: new Set(),
  splitCount: 0,
  deaths: [],
  limitUntil: 0,
})

const hasBreak = (state: WorldState, name: Break): boolean => state.config.breaks.includes(name)

const replaceLine = (frame: string, from: string, to: string): string =>
  frame
    .split("\n")
    .map((line) => {
      if (line === from) return to
      return line
    })
    .join("\n")

const LIMIT_FRAME = [
  "",
  "  Antigravity CLI 1.5.16",
  "",
  "  Individual quota reached for Gemini 4 Neon. Resets in 0h0m1s.",
  "────────────────────────────────────────────────────────────────────────────────",
  "> ",
  "────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                                      auto · Gemini 4 Neon · high",
].join("\n")

/** The text a pane shows, built from the recorded agy frames with this turn's prompt and answer. */
export const render = (pane: Pane): string => {
  const prompt = `> ${pane.lastPrompt}`
  if (pane.screen === "working") return replaceLine(WORKING_FRAME, "> Reply with only the single word: pong", prompt)
  if (pane.screen === "done") {
    const withPrompt = replaceLine(DONE_FRAME, "> Reply with only the single word: pong", prompt)
    return replaceLine(withPrompt, "  pong", `  ${pane.lastAnswer}`)
  }
  if (pane.screen === "trust") return TRUST_FRAME
  if (pane.screen === "permission") return PERMISSION_FRAME
  if (pane.screen === "prompt") return SIGNIN_FRAME
  if (pane.screen === "limit") return LIMIT_FRAME
  return READY_FRAME
}

const RESULT_PATH = /write your final answer to (\S+?)(?:\.tmp)?(?:,|\.(?:\s|$))/

export const resultFileOf = (brief: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(RESULT_PATH.exec(brief)), (match) => Option.fromUndefinedOr(match[1]))

export const tokenOf = (text: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(TOKEN.exec(text)), (match) => Option.fromUndefinedOr(match[0]))

const promptLineOf = (brief: string): string =>
  Option.getOrElse(tokenOf(brief), () => brief.split("\n").find((line) => line.trim().length > 0) ?? "")

const updatePane = (state: WorldState, blockId: string, f: (pane: Pane) => Pane): WorldState => ({
  ...state,
  panes: state.panes.map((pane) => {
    if (pane.blockId === blockId) return f(pane)
    return pane
  }),
})

const updateRun = (state: WorldState, id: number, f: (run: Run) => Run): WorldState => ({
  ...state,
  runs: state.runs.map((run) => {
    if (run.id === id) return f(run)
    return run
  }),
})

export const findPane = (state: WorldState, blockId: string): Option.Option<Pane> =>
  Option.fromUndefinedOr(state.panes.find((pane) => pane.blockId === blockId))

const takeFileMode = (state: WorldState): readonly [FileMode, WorldState] => {
  const [head, ...rest] = state.config.fileModes
  return [head ?? "final", { ...state, config: { ...state.config, fileModes: rest } }]
}

const writeFile = (state: WorldState, path: Option.Option<string>, content: string, mtimeMs: number): WorldState =>
  Option.match(path, {
    onNone: () => state,
    onSome: (p) => ({ ...state, files: new Map([...state.files, [p, { content, mtimeMs }]]) }),
  })

/** A run started while the sign-in's quota is spent meets the limit at once. */
const workMsOf = (state: WorldState): number => {
  if (state.now < state.limitUntil) return 1
  return state.config.workMs
}

/** Starts a turn in a pane: the brief was submitted, the agent is now working on it. */
export const startRun = (state: WorldState, blockId: string, brief: string, human: boolean): WorldState => {
  const [fileMode, withMode] = takeFileMode(state)
  const id = withMode.runs.length + 1
  const resultFile = resultFileOf(brief)
  const run: Run = {
    id,
    blockId,
    brief,
    token: tokenOf(brief),
    human,
    resultFile,
    fileMode,
    startedAt: state.now,
    endsAt: state.now + workMsOf(state),
    permissionAt: Option.some(state.now + Math.floor(state.config.workMs / 3)).pipe(Option.filter(() => state.config.permissionRuns.includes(id))),
    endedAt: Option.none(),
    interrupted: false,
    limited: state.config.limitRuns.includes(id) || state.now < state.limitUntil,
    resetAt: Option.none(),
  }
  const stale = Option.filter(resultFile, () => fileMode === "stale")
  const staled = writeFile(withMode, stale, STALE_CONTENT, Math.max(0, state.now - 10_000))
  const next = { ...staled, runs: [...staled.runs, run] }
  return updatePane(next, blockId, (pane) => ({
    ...pane,
    screen: "working",
    current: Option.some(id),
    lastPrompt: promptLineOf(brief),
    nextStartAt: Option.none(),
  }))
}

const interruptCurrent = (state: WorldState, pane: Pane): WorldState =>
  Option.match(pane.current, {
    onNone: () => state,
    onSome: (id) => updateRun(state, id, (run) => ({ ...run, endedAt: Option.some(state.now), interrupted: true })),
  })

const submit = (state: WorldState, pane: Pane, steer: boolean): WorldState => {
  const text = pane.input
  const cleared = updatePane(state, pane.blockId, (p) => ({ ...p, input: "" }))
  if (pane.screen === "trust") return updatePane(cleared, pane.blockId, (p) => ({ ...p, screen: "ready" }))
  if (pane.screen === "permission") return updatePane(cleared, pane.blockId, (p) => ({ ...p, screen: "working" }))
  if (pane.screen === "prompt" || pane.screen === "exited" || text.length === 0) return cleared
  if (pane.screen === "limit") return resume(cleared, pane, text)
  if (pane.screen === "working" && !steer) return updatePane(cleared, pane.blockId, (p) => ({ ...p, queue: [...p.queue, text] }))
  if (pane.screen === "working") return startRun(interruptCurrent(cleared, pane), pane.blockId, text, !TOKEN.test(text))
  return startRun(cleared, pane.blockId, text, !TOKEN.test(text))
}

const ALL_TOKENS = new RegExp(TOKEN.source, "g")

/** The brief the continued run works on: the limited run's own (its token kept), unless the agent is broken. */
const continuedBrief = (state: WorldState, brief: string): string => {
  if (hasBreak(state, "continue-loses-token")) return brief.replace(ALL_TOKENS, "lost-token")
  return brief
}

/**
 * Text submitted at the usage-limit screen. `continue` after the reset continues the limited run: the SAME
 * turn, same brief, token and result file (SPEC v2 ruling 5). Before the reset agy still refuses it. Any
 * other text is a new prompt.
 */
const resume = (state: WorldState, pane: Pane, text: string): WorldState => {
  if (text.trim().toLowerCase() !== "continue") return startRun(state, pane.blockId, text, !TOKEN.test(text))
  const limited = Option.fromUndefinedOr(state.runs.findLast((run) => run.blockId === pane.blockId && run.limited))
  if (Option.isNone(limited) || Option.exists(limited.value.resetAt, (at) => state.now < at)) return state
  return startRun(state, pane.blockId, continuedBrief(state, limited.value.brief), false)
}

const ESC = String.fromCharCode(27)
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`
const STEER = `${ESC}m`

const pasted = (data: string): Option.Option<string> =>
  Option.liftPredicate(data, (d) => d.startsWith(PASTE_START) && d.endsWith(PASTE_END)).pipe(Option.map((d) => d.slice(PASTE_START.length, d.length - PASTE_END.length)))

const firstPaste = (state: WorldState, blockId: string): boolean =>
  !state.writes.some((write) => write.blockId === blockId && Option.isSome(pasted(write.data)))

/** The pane's log of one write; the broken echo and late-stamp panes log it wrongly (non-vacuity only). */
const writeRecords = (state: WorldState, pane: Pane, data: string, proc: number): ReadonlyArray<WriteRecord> => {
  const late = hasBreak(state, "late-stamp-first-paste") && Option.isSome(pasted(data)) && firstPaste(state, pane.blockId)
  const record: WriteRecord = { at: state.now + Number(late) * LATE_STAMP_MS, proc, blockId: pane.blockId, data, screen: pane.screen, owned: pane.owned }
  if (hasBreak(state, "echo-writes") && proc >= 0) return [record, record]
  return [record]
}

/** The agent's reading of bytes written to its pane: paste, Enter (submit, queue or confirm a prompt), Alt+M (steer), Esc. */
export const applyWrite = (state: WorldState, blockId: string, data: string, proc: number): WorldState => {
  const found = findPane(state, blockId)
  if (Option.isNone(found)) return state
  const pane = found.value
  const logged: WorldState = { ...state, writes: [...state.writes, ...writeRecords(state, pane, data, proc)] }
  const paste = pasted(data)
  if (Option.isSome(paste)) return updatePane(logged, blockId, (p) => ({ ...p, input: p.input + paste.value }))
  if (data === "\r") return submit(logged, pane, false)
  if (data === STEER) return submit(logged, pane, true)
  if (data === ESC && pane.screen === "working") {
    return updatePane(interruptCurrent(logged, pane), blockId, (p) => ({ ...p, screen: "ready", current: Option.none() }))
  }
  if (data.startsWith(ESC)) return logged
  return updatePane(logged, blockId, (p) => ({ ...p, input: p.input + data }))
}

/**
 * The run meets the usage limit: no answer, the quota frame, and the whole sign-in limited until the reset.
 * Text queued in the pane waits for the reset.
 */
const limitRun = (state: WorldState, pane: Pane, run: Run): WorldState => {
  const until = Math.max(state.limitUntil, state.now + LIMIT_MS)
  const ended = updateRun({ ...state, limitUntil: until }, run.id, (r) => ({ ...r, limited: true, endedAt: Option.some(state.now), resetAt: Option.some(until) }))
  const nextStartAt = Option.filter(Option.some(until), () => pane.queue.length > 0)
  return updatePane(ended, pane.blockId, (p) => ({ ...p, screen: "limit", current: Option.none(), nextStartAt }))
}

const finishRun = (state: WorldState, pane: Pane, run: Run): WorldState => {
  if (run.limited) return limitRun(state, pane, run)
  const answer = Option.match(run.token, { onNone: () => "human answer", onSome: answerOf })
  const withFile = writeFile(state, Option.filter(run.resultFile, () => run.fileMode === "final" || run.fileMode === "partial"), answer, state.now)
  const ended = updateRun(withFile, run.id, (r) => ({ ...r, endedAt: Option.some(state.now) }))
  const nextStartAt = Option.filter(Option.some(state.now + state.config.queueGapMs), () => pane.queue.length > 0)
  return updatePane(ended, pane.blockId, (p) => ({ ...p, screen: "done", current: Option.none(), lastAnswer: answer, nextStartAt }))
}

const tickRun = (state: WorldState, pane: Pane, run: Run): WorldState => {
  if (pane.screen !== "working") return state
  if (state.now < state.limitUntil && !run.limited) return limitRun(state, pane, run)
  if (Option.exists(run.permissionAt, (at) => state.now >= at)) {
    const asked = updateRun(state, run.id, (r) => ({ ...r, permissionAt: Option.none() }))
    return updatePane(asked, pane.blockId, (p) => ({ ...p, screen: "permission" }))
  }
  const half = run.startedAt + Math.floor((run.endsAt - run.startedAt) / 2)
  const placeholder = run.fileMode === "partial" && state.now >= half && !state.files.has(Option.getOrElse(run.resultFile, () => ""))
  const placed = writeFile(state, Option.filter(run.resultFile, () => placeholder), PLACEHOLDER, state.now)
  if (state.now < run.endsAt) return placed
  return finishRun(placed, pane, run)
}

const tickPane = (state: WorldState, pane: Pane): WorldState => {
  if (!pane.alive || pane.closed) return state
  const running = Option.flatMap(pane.current, (id) => Option.fromUndefinedOr(state.runs.find((run) => run.id === id)))
  if (Option.isSome(running)) return tickRun(state, pane, running.value)
  if (Option.exists(pane.nextStartAt, (at) => state.now >= at)) {
    const [head, ...rest] = pane.queue
    const dequeued = updatePane(state, pane.blockId, (p) => ({ ...p, queue: rest, nextStartAt: Option.none() }))
    return startRun(dequeued, pane.blockId, head ?? "", false)
  }
  return state
}

/** Advances the agents in every pane to `now`. */
export const tick = (state: WorldState, now: number): WorldState => {
  const at = { ...state, now }
  return at.panes.reduce((acc, pane) => Option.match(findPane(acc, pane.blockId), { onNone: () => acc, onSome: (p) => tickPane(acc, p) }), at)
}

/** Creates the agent pane a split asks for, showing the first configured start screen (ready by default). */
export const applySplit = (state: WorldState, input: SplitRightInput, proc: number): readonly [string, WorldState] => {
  const blockId = `block:sim-${state.nextBlock}`
  const [first, ...rest] = state.config.splitScreens
  const pane: Pane = { ...ownerPane(blockId, first ?? "ready"), sessionId: input.sessionId, label: input.label, command: input.command, cwd: input.cwd, owned: true }
  const withPane: WorldState = {
    ...state,
    nextBlock: state.nextBlock + 1,
    splitCount: state.splitCount + 1,
    config: { ...state.config, splitScreens: rest },
    panes: [...state.panes, pane],
    splits: [...state.splits, { at: state.now, proc, blockId, input }],
  }
  const resume = input.command.indexOf("-i")
  if (resume < 0) return [blockId, withPane]
  return [blockId, startRun(withPane, blockId, input.command[resume + 1] ?? "", false)]
}

export const applyClose = (state: WorldState, blockId: string, proc: number): WorldState => {
  const owned = Option.exists(findPane(state, blockId), (pane) => pane.owned)
  const logged = { ...state, closes: [...state.closes, { at: state.now, proc, blockId, owned }] }
  return paneDies(logged, blockId, true)
}

/** The pane's process ends (and, when `closed`, its block is gone too); the world logs when. */
export const paneDies = (state: WorldState, blockId: string, closed: boolean): WorldState => {
  const logged = { ...state, deaths: [...state.deaths, { blockId, at: state.now }] }
  return updatePane(logged, blockId, (pane) => ({ ...pane, closed: pane.closed || closed, alive: false, screen: "exited" }))
}

/** When the world saw a pane die, if it did. */
export const goneAt = (state: WorldState, blockId: string): Option.Option<number> =>
  Option.map(Option.fromUndefinedOr(state.deaths.find((death) => death.blockId === blockId)), (death) => death.at)

/** Human or environment actions on the world: what the owner does in a pane and how the agent's process ends. */
export type WorldEvent = Data.TaggedEnum<{
  ClearPrompt: { readonly blockId: Option.Option<string> }
  ShowPrompt: { readonly blockId: Option.Option<string>; readonly screen: ScreenKind }
  HumanTypes: { readonly blockId: Option.Option<string>; readonly text: string }
  PaneExits: { readonly blockId: Option.Option<string> }
  OwnerCloses: { readonly blockId: Option.Option<string> }
}>
export const WorldEvent = Data.taggedEnum<WorldEvent>()

const lastOwned = (state: WorldState): Option.Option<string> =>
  Option.map(Option.fromUndefinedOr(state.panes.filter((pane) => pane.owned && pane.alive).at(-1)), (pane) => pane.blockId)

const clearPrompt = (state: WorldState, pane: Pane): WorldState => {
  if (!PROMPT_SCREENS.includes(pane.screen)) return state
  const back: ScreenKind = Option.match(pane.current, { onNone: () => "ready", onSome: () => "working" })
  return updatePane(state, pane.blockId, (p) => ({ ...p, screen: back }))
}

const humanTypes = (state: WorldState, pane: Pane, text: string): WorldState => {
  const typed = applyWrite(state, pane.blockId, text, -1)
  return applyWrite(typed, pane.blockId, "\r", -1)
}

export const applyEvent = (state: WorldState, event: WorldEvent): WorldState => {
  const target = Option.orElse(event.blockId, () => lastOwned(state))
  const found = Option.flatMap(target, (blockId) => findPane(state, blockId))
  if (Option.isNone(found)) return state
  const pane = found.value
  return WorldEvent.$match(event, {
    ClearPrompt: () => clearPrompt(state, pane),
    ShowPrompt: (e) => updatePane(state, pane.blockId, (p) => ({ ...p, screen: e.screen })),
    HumanTypes: (e) => humanTypes(state, pane, e.text),
    PaneExits: () => paneDies(state, pane.blockId, false),
    OwnerCloses: () => paneDies(state, pane.blockId, true),
  })
}

/** The shared world: panes, files, the store, delivered wakes. It survives every process crash. */
export interface World {
  readonly state: Ref.Ref<WorldState>
  readonly get: Effect.Effect<WorldState>
  readonly update: (f: (state: WorldState) => WorldState) => Effect.Effect<void>
  readonly modify: <A>(f: (state: WorldState) => readonly [A, WorldState]) => Effect.Effect<A>
  readonly procAlive: (proc: number) => Effect.Effect<boolean>
  readonly kill: (proc: number) => Effect.Effect<void>
}

export const makeWorld = Effect.fn("Sim.makeWorld")(function* (config: WorldConfig) {
  const state = yield* Ref.make(initialWorld(config))
  const world: World = {
    state,
    get: Ref.get(state),
    update: (f) => Ref.update(state, f),
    modify: (f) => Ref.modify(state, (s) => {
      const [a, next] = f(s)
      return [a, next]
    }),
    procAlive: (proc) => Effect.map(Ref.get(state), (s) => !s.deadProcs.has(proc)),
    kill: (proc) => Ref.update(state, (s) => ({ ...s, deadProcs: new Set([...s.deadProcs, proc]) })),
  }
  return world
})
