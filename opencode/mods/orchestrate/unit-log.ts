// A unit's transitions, as the plugin writes them to the unit's log.md
// (the orchestrate skill's log.ts, `--current`): a role's start, read from its
// call's description (`<role> <unit> r<N>`, described.ts), and its hand-back,
// read from the first line of its last answer (`<role> <unit> r<N>: <verdict>
// <path>`, protocol.md, Ending a step). The moves are the skill's machine:
//
//   planner starts      → plan       r<N>
//   implementor starts  → implement  r<N>   spec.md, or the last round's findings
//   verifier starts     → verify     r<N>   round-N-request.md
//   implementor ready   → verify     r<N>
//   verifier accepted   → decide     r<N>
//   verifier changes    → implement  r<N+1>
//   verifier stuck      → decide     r<N>   (as stuck)
//   any role blocked    → blocked    r<N>
//
// A planner's `ready` moves nothing: the spec waits for the orchestrator's
// approval, and the implementor's start moves the unit on.
//
// Where the unit dir is comes from the paths the prompt or the hand-back
// names (`<unit dir>/spec.md`, `<unit dir>/round-1-request.md`): the prefix up
// to the segment that is the unit's name. The store also looks under the
// session's checkout (service.ts UnitLogs). Only a unit dir counts (it holds
// spec.md or log.md, or its run dir holds plan.md), so a Rift that shares the
// unit's name gets no log.md; when none is found, nothing is written.
import { described, isStep, type Step } from "./described.ts"

/** One move of a unit, as log.ts takes it: the state it moves to, the round, and the note (its cause first). */
export interface Transition {
  readonly unit: string
  readonly to: "plan" | "implement" | "verify" | "decide" | "blocked"
  readonly round: number
  readonly note: string
}

const STARTS: Readonly<Record<Step, Transition["to"]>> = { planner: "plan", implementor: "implement", verifier: "verify" }

/** A unit slug as the skill writes it: one lowercase word. */
const UNIT = /^[a-z0-9][a-z0-9._-]*$/
const ROUND = /^r(\d+)$/i

/** The cause a start's line names: the file the role starts from. */
const startCause = (role: Step, round: number) =>
  role === "planner" ? "" : role === "verifier" ? `round-${round}-request.md` : round > 1 ? `round-${round - 1}-findings.md` : "spec.md"

/**
 * The move a role's start makes, from its call's description; none for an
 * agent that is not a step, a description that names no step or another role,
 * or one that names no round.
 */
export const startOf = (agent: string, description: string | undefined): Transition | undefined => {
  if (!isStep(agent)) return undefined
  const step = described(description)
  if (step === undefined || step.role !== agent) return undefined
  const [unit, ...rest] = step.rest.split(" ")
  const round = rest.map((word) => ROUND.exec(word)?.[1]).find((n) => n !== undefined)
  if (unit === undefined || !UNIT.test(unit) || ROUND.test(unit) || round === undefined) return undefined
  return { unit, to: STARTS[agent], round: Number(round), note: startCause(agent, Number(round)) }
}

/** The hand-back line: `<role> <unit> r<N>: <verdict> <path>`, maybe in backticks or bold. */
const HAND_BACK = /^[`*\s]*(planner|implementor|verifier) ([a-z0-9][a-z0-9._-]*) r(\d+):\s*(ready|blocked|accepted|changes|stuck)\b[`*]*\s*([^\s`*]*)/i

/** A role's hand-back: its move, and the file it names (as written, maybe relative). */
export interface HandBack {
  readonly transition: Transition | undefined
  readonly file: string | undefined
}

/**
 * The hand-back a role's last answer opens with, read only for the role it
 * names being the agent's own; none for any other answer. A planner's
 * `ready` is a hand-back that moves nothing.
 */
export const handBackOf = (agent: string, text: string | undefined): HandBack | undefined => {
  const first = (text ?? "").split("\n").find((line) => line.trim() !== "") ?? ""
  const match = HAND_BACK.exec(first)
  if (match === null) return undefined
  const [, role, unit, n, said, path] = match
  if (role === undefined || unit === undefined || n === undefined || said === undefined || role.toLowerCase() !== agent) return undefined
  const verdict = said.toLowerCase()
  const round = Number(n)
  const file = path === undefined || path === "" ? undefined : path
  const name = file?.split("/").pop()
  const note = name === undefined ? verdict : `${name} ${verdict}`
  const move = (to: Transition["to"], at = round): Transition => ({ unit, to, round: at, note })
  const transition =
    verdict === "blocked"
      ? move("blocked")
      : agent === "implementor" && verdict === "ready"
        ? move("verify")
        : agent === "verifier" && (verdict === "accepted" || verdict === "stuck")
          ? move("decide")
          : agent === "verifier" && verdict === "changes"
            ? move("implement", round + 1)
            : undefined
  return { transition, file }
}

/** A path in prose: a word with a slash in it (absolute, `~/` or relative), up to a space, quote, backtick or bracket. */
const PATH = /(?:^|[\s`'"(<[])([^\s`'"()<>[\]]*\/[^\s`'"()<>[\]]*)/g

/**
 * The unit dirs the text names: for each path in it with a segment that is
 * `unit`, the path up to that segment, in the order they appear.
 */
export const unitDirsIn = (text: string | undefined, unit: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  for (const match of (text ?? "").matchAll(PATH)) {
    const segments = (match[1] ?? "").replace(/[.,:;]+$/, "").split("/")
    // The last such segment: a run may share its unit's name.
    const at = segments.lastIndexOf(unit)
    if (at < 0) continue
    const dir = segments.slice(0, at + 1).join("/")
    if (!found.includes(dir)) found.push(dir)
  }
  return found
}
