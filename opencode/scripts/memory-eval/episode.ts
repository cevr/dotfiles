// One episode: session 1 (the agent learns the scenario's facts) and session 2
// (a fresh context where they matter), sharing one memory store, on one arm.
// The `none` arm runs session 2 only: with no memory, session 1 cannot reach it.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addUsage, type Block, create, emptyUsage, type Ledger, type Message, MODEL, type ModelId, type Usage } from "./api.ts"
import { grade, type Graded } from "./grade.ts"
import { type MemoryArm, native, ours, type Stored } from "./memory.ts"
import type { Call, Scenario } from "./scenarios.ts"
import { basePrompt, DISTRACTORS, SHELL } from "./tools.ts"
import { newWorld, runDistractor, runShell } from "./world.ts"

export const ARMS = ["none", "ours", "ours+pointer", "native"] as const
export type Arm = (typeof ARMS)[number]

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

const short = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max) + "…")

const runSession = async (
  ledger: Ledger,
  scenario: Scenario,
  arm: Arm,
  memory: MemoryArm | undefined,
  session: 1 | 2,
): Promise<SessionResult> => {
  const world = newWorld(scenario.cwd, scenario.files, scenario.branches[session - 1]!, scenario.noise, scenario.outside)
  const sessionID = `session-${session}`
  const extra = [...(arm === "ours+pointer" ? [POINTER] : []), ...(memory === undefined ? [] : await memory.system(sessionID))]
  const system = [basePrompt(scenario.cwd), ...extra].map((text) => ({ type: "text" as const, text }))
  const tools = [SHELL, ...DISTRACTORS, ...(memory?.tools ?? [])]
  const messages: Array<Message> = []
  const calls: Array<Call> = []
  const transcript: Array<string> = []
  const usage = emptyUsage()
  let requests = 0
  let cappedTurns = 0
  let step = 0

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
      const response = await create(ledger, { system, tools, messages })
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
        step += 1
        const input = use.input ?? {}
        let output: string
        let error: boolean
        if (memory !== undefined && memory.names.has(use.name)) {
          const answer = await memory.call(sessionID, use.name, input)
          output = answer.text
          error = answer.error
        } else if (use.name === "shell") {
          const outcome = runShell(String(input["command"] ?? ""), world, scenario.rules)
          output = outcome.out
          error = outcome.code !== 0
        } else {
          const outcome = runDistractor(use.name, input, world)
          output = outcome.out
          error = outcome.code !== 0
        }
        calls.push({ session, step, name: use.name, input, output, error })
        transcript.push(`→ ${use.name} ${short(JSON.stringify(input), 300)}`, `← ${short(output, 240)}`)
        results.push({ type: "tool_result", tool_use_id: use.id, content: output, ...(error ? { is_error: true } : {}) })
      }
      messages.push({ role: "user", content: results })
    }
    if (!ended) cappedTurns += 1
  }
  return { requests, usage, calls, extra, transcript, cappedTurns }
}

const memoryFor = async (arm: Arm, dir: string): Promise<MemoryArm | undefined> => {
  if (arm === "none") return undefined
  if (arm === "native") return native(dir)
  return ours(dir)
}

/** One episode on `arm`, its scratch store in a temp directory removed at the end. */
export const runEpisode = async (ledger: Ledger, scenario: Scenario, arm: Arm, repeat: number): Promise<EpisodeResult> => {
  const dir = mkdtempSync(join(tmpdir(), "memory-eval-"))
  const memory = await memoryFor(arm, dir)
  try {
    const s1 = arm === "none" ? undefined : await runSession(ledger, scenario, arm, memory, 1)
    const stored1 = memory?.stored() ?? { units: [], documents: [] }
    const s2 = await runSession(ledger, scenario, arm, memory, 2)
    const stored2 = memory?.stored() ?? { units: [], documents: [] }
    const graded = grade(scenario, s1?.calls ?? [], s2.calls, s2.extra, stored1, stored2)
    return { model: MODEL, arm, scenario: scenario.id, repeat, ...(s1 === undefined ? {} : { s1 }), s2, stored1, stored2, graded }
  } finally {
    await memory?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
