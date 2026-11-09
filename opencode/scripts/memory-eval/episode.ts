// One episode: session 1 (the agent learns the scenario's facts) and session 2
// (a fresh context where they matter), sharing one memory store, on one arm.
// The `none` arm runs session 2 only: with no memory, session 1 cannot reach it.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addUsage, type Block, create, emptyUsage, type Ledger, type Message, MODEL, type ModelId, type Usage } from "./api.ts"
import { grade, type Graded } from "./grade.ts"
import { type MemoryArm, native, ours, type Stored, type Variant, VARIANTS } from "./memory.ts"
import type { Call, Scenario } from "./scenarios.ts"
import { kernelTool, listingOf, newKernel } from "./kernel.ts"
import { NUDGE, retryFixed, type ShellRun } from "./retry.ts"
import { basePrompt, DISTRACTORS, SHELL, type ToolDef } from "./tools.ts"
import { newWorld, runDistractor, runShell } from "./world.ts"

export const ARMS = [
  "none",
  "ours",
  "ours+pointer",
  "native",
  "kernel",
  "ours+nudge",
  "kernel+nudge",
  "kernel+direct",
  "kernel+direct+describe",
  "kernel+direct+followup",
  "kernel+direct+plain",
] as const
export type Arm = (typeof ARMS)[number]

/** The arms that reach memory through the kernel (kernel.ts): its only tool, or beside the memory tools. */
export const throughKernel = (arm: Arm): boolean => arm.startsWith("kernel")
/** The kernel arm as production runs it since 9535f78: the memory tools offered directly beside the kernel; round 4's candidates on it. */
export const directBeside = (arm: Arm): boolean => arm.startsWith("kernel+direct")
/** The words of memory_save an arm offers: production's, a round-4 candidate's, or production's before round 5 (memory.ts). */
export const variantOf = (arm: Arm): Variant =>
  arm === "kernel+direct+describe"
    ? VARIANTS.describe
    : arm === "kernel+direct+followup"
      ? VARIANTS.followup
      : arm === "kernel+direct+plain"
        ? VARIANTS.plain
        : VARIANTS.production
/** The arms whose shell results carry the gotcha trigger (retry.ts). */
export const nudged = (arm: Arm): boolean => arm.endsWith("+nudge")
/** The arms on our memory, with its digest. */
export const onOurs = (arm: Arm): boolean => arm !== "none" && arm !== "native"

/** The one line `ours+pointer` adds to the system prompt, notes or none. */
export const POINTER =
  "Memory: memory_save keeps one-line notes across sessions. Save one when the user corrects you or states a preference, or when you learn a non-obvious fact about this project (a command that only works one way); memory_search before guessing this project's conventions."

/** The most model steps one user turn may take. */
const STEPS_PER_TURN = 30

export interface SessionResult {
  readonly requests: number
  readonly usage: Usage
  readonly calls: ReadonlyArray<Call>
  /** The system blocks the arm added after the base prompt (the pointer, the digest). */
  readonly extra: ReadonlyArray<string>
  readonly transcript: ReadonlyArray<string>
  readonly cappedTurns: number
  /** How many tool results carried the gotcha trigger's line. */
  readonly nudges?: number
}

export interface EpisodeResult {
  readonly model: ModelId
  readonly arm: Arm
  readonly scenario: string
  readonly repeat: number
  readonly s1?: SessionResult
  readonly s2: SessionResult
  readonly stored1: Stored
  readonly stored2: Stored
  readonly graded: Graded
  readonly error?: string
}

interface Dispatched {
  readonly output: string
  readonly error: boolean
  readonly nudge: boolean
}

const short = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max) + "…")

const runSession = async (
  ledger: Ledger,
  scenario: Scenario,
  arm: Arm,
  memory: MemoryArm | undefined,
  session: 1 | 2,
  repeat: number,
): Promise<SessionResult> => {
  const world = newWorld(scenario.cwd, scenario.files, scenario.branches[session - 1]!, scenario.noise, scenario.outside, scenario.history)
  const sessionID = `session-${session}`
  /** The session as the pool places it: one account for its life, so its prompt cache stays there. */
  const placed = `memory-eval/${arm}/${scenario.id}/${repeat}/s${session}`
  const extra = [...(arm === "ours+pointer" ? [POINTER] : []), ...(memory === undefined ? [] : await memory.system(sessionID))]
  const system = [basePrompt(scenario.cwd), ...extra].map((text) => ({ type: "text" as const, text }))
  const memoryTools = (memory?.tools ?? []) as ReadonlyArray<ToolDef>
  const tools = throughKernel(arm)
    ? [kernelTool(memoryTools, directBeside(arm)), ...(directBeside(arm) ? memoryTools : [])]
    : [SHELL, ...DISTRACTORS, ...memoryTools]
  const kernel = throughKernel(arm) ? newKernel(listingOf(memoryTools), scenario.cwd) : undefined
  const messages: Array<Message> = []
  const calls: Array<Call> = []
  const transcript: Array<string> = []
  const usage = emptyUsage()
  const shellRuns: Array<ShellRun> = []
  let requests = 0
  let cappedTurns = 0
  let step = 0
  let nudges = 0

  /** One tool call, answered and recorded; `nudge` when it is a shell retry that fixed a failure, on an arm with the trigger. */
  /** `inCell` when a kernel cell made the call: the transcript indents it under the cell. */
  const dispatch = (name: string, input: Record<string, unknown>, inCell = kernel !== undefined): Dispatched | Promise<Dispatched> => {
    step += 1
    const at = step
    if (memory !== undefined && memory.names.has(name))
      return memory.call(sessionID, name, input).then((answer) => record(at, name, input, answer.text, answer.error, inCell))
    const outcome = name === "shell" ? runShell(String(input["command"] ?? ""), world, scenario.rules) : runDistractor(name, input, world)
    return record(at, name, input, outcome.out, outcome.code !== 0, inCell)
  }

  const record = (at: number, name: string, input: Record<string, unknown>, output: string, error: boolean, inCell: boolean): Dispatched => {
    let nudge = false
    if (name === "shell") {
      const run = { command: String(input["command"] ?? ""), failed: error }
      nudge = nudged(arm) && retryFixed(shellRuns, run)
      shellRuns.push(run)
    }
    calls.push({ session, step: at, name, input, output, error })
    transcript.push(`${inCell ? "  ⇢" : "→"} ${name} ${short(JSON.stringify(input), 300)}`, `${inCell ? "  ⇠" : "←"} ${short(output, 240)}`)
    if (nudge) transcript.push("  [nudge]")
    return { output, error, nudge }
  }

  /** A tool_use block's result: a direct call, or a kernel cell and the calls it made. */
  const answer = async (name: string, input: Record<string, unknown>): Promise<{ output: string; error: boolean }> => {
    // With the kernel, a call of a tool it does not offer is refused as OpenCode refuses it; `kernel+direct` offers memory's.
    const offered = name === "kernel" || (directBeside(arm) && memory !== undefined && memory.names.has(name))
    if (kernel !== undefined && !offered) {
      transcript.push(`→ ${name} (not a tool here)`)
      return { output: `Tool is not available for this request: ${name}`, error: true }
    }
    if (kernel === undefined || name !== "kernel") {
      const result = await dispatch(name, input, false)
      if (!result.nudge) return result
      nudges += 1
      return { output: `${result.output}\n\n${NUDGE}`, error: result.error }
    }
    transcript.push(`→ kernel ${short(String(input["code"] ?? ""), 600)}`)
    let fired = false
    const cell = await kernel.run(String(input["code"] ?? ""), (inner, innerInput) => {
      const result = dispatch(inner, innerInput)
      if (result instanceof Promise) return result.then((settled) => ((fired ||= settled.nudge), settled))
      fired ||= result.nudge
      return result
    })
    transcript.push(`← ${short(cell.text, 300)}`)
    if (!fired) return { output: cell.text, error: !cell.ok }
    nudges += 1
    return { output: `${cell.text}\n\n${NUDGE}`, error: !cell.ok }
  }

  /** A user turn: its own message, or added to the tool results a capped turn left last. */
  const say = (text: string) => {
    transcript.push(`user: ${text}`)
    const last = messages.at(-1)
    if (last !== undefined && last.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text })
    else messages.push({ role: "user", content: [{ type: "text", text }] })
  }

  const turns = session === 1 ? scenario.session1 : scenario.session2
  for (const turn of turns) {
    say(typeof turn === "string" ? turn : turn(calls))
    let ended = false
    for (let i = 0; i < STEPS_PER_TURN; i++) {
      const response = await create(ledger, { system, tools, messages, session: placed })
      requests += 1
      addUsage(usage, response.usage)
      messages.push({ role: "assistant", content: response.content })
      for (const block of response.content) if (block.type === "text" && block.text.trim() !== "") transcript.push(`assistant: ${short(block.text.trim(), 400)}`)
      const uses = response.content.filter((block): block is Extract<Block, { type: "tool_use" }> => block.type === "tool_use")
      if (uses.length === 0) {
        ended = true
        break
      }
      const results: Array<Block> = []
      for (const use of uses) {
        const { output, error } = await answer(use.name, use.input ?? {})
        results.push({ type: "tool_result", tool_use_id: use.id, content: output, ...(error ? { is_error: true } : {}) })
      }
      messages.push({ role: "user", content: results })
    }
    if (!ended) cappedTurns += 1
  }
  return { requests, usage, calls, extra, transcript, cappedTurns, nudges }
}

const memoryFor = async (arm: Arm, dir: string): Promise<MemoryArm | undefined> => {
  if (arm === "none") return undefined
  if (arm === "native") return native(dir)
  return ours(dir, variantOf(arm))
}

/** One episode on `arm`, its scratch store in a temp directory removed at the end. */
export const runEpisode = async (ledger: Ledger, scenario: Scenario, arm: Arm, repeat: number): Promise<EpisodeResult> => {
  const dir = mkdtempSync(join(tmpdir(), "memory-eval-"))
  const memory = await memoryFor(arm, dir)
  try {
    const s1 = arm === "none" ? undefined : await runSession(ledger, scenario, arm, memory, 1, repeat)
    const stored1 = memory?.stored() ?? { units: [], documents: [] }
    const s2 = await runSession(ledger, scenario, arm, memory, 2, repeat)
    const stored2 = memory?.stored() ?? { units: [], documents: [] }
    const graded = grade(scenario, s1?.calls ?? [], s2.calls, s2.extra, stored1, stored2)
    return { model: MODEL, arm, scenario: scenario.id, repeat, ...(s1 === undefined ? {} : { s1 }), s2, stored1, stored2, graded }
  } finally {
    await memory?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
