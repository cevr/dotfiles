// Grading, all deterministic: which facts the store holds after each session
// (every key of the fact matches one note or one memory file), whether session
// 2 read memory before it acted, which facts session 2's tool calls honoured,
// and the stored units that hold none of the facts.
import { HEADING } from "../../mods/memory/digest.ts"
import type { Stored } from "./memory.ts"
import type { Call, Fact, Scenario } from "./scenarios.ts"

export interface Graded {
  /** Per fact: held by the store after session 1. */
  readonly saved: Record<string, boolean>
  /** Per fact: session 2 honoured it. */
  readonly correct: Record<string, boolean>
  /** Session 2 searched or viewed memory before its first other tool call. */
  readonly readBeforeAct: boolean
  /** Session 2 searched or viewed memory at all. */
  readonly readAny: boolean
  /** Session 2's system prompt carried our digest. */
  readonly digest: boolean
  readonly writes1: number
  readonly writes2: number
  /** Stored units (notes, or memory-file lines) after session 1 and after session 2. */
  readonly units1: number
  readonly units2: number
  /** Units that hold no fact of the scenario. */
  readonly offList1: number
  readonly offList2: number
  /** Off-list units that record task state or progress, which memory should not hold. */
  readonly taskState1: number
  readonly taskState2: number
}

export const isMemory = (name: string): boolean => name === "memory" || name.startsWith("memory_")
export const isRead = (call: Pick<Call, "name" | "input">): boolean => call.name === "memory_search" || (call.name === "memory" && call.input["command"] === "view")
export const isWrite = (call: Pick<Call, "name" | "input">): boolean =>
  call.name === "memory_save" || call.name === "memory_forget" || (call.name === "memory" && call.input["command"] !== "view")

export const holds = (fact: Fact, text: string): boolean => fact.keys.every((key) => key.test(text))
/** A unit touches a fact when any one of its keys matches. */
const touches = (facts: ReadonlyArray<Fact>, text: string): boolean => facts.some((fact) => fact.keys.some((key) => key.test(text)))

const TASK_STATE = /\b(progress|status|completed?|done|in progress|next steps?|todo|task|fixed|implemented|committed|current(ly)?|session|pending|working on)\b/i

const units = (facts: ReadonlyArray<Fact>, stored: Stored) => {
  const off = stored.units.filter((unit) => !touches(facts, unit))
  return { count: stored.units.length, off: off.length, taskState: off.filter((unit) => TASK_STATE.test(unit)).length }
}

export const grade = (
  scenario: Scenario,
  calls1: ReadonlyArray<Call>,
  calls2: ReadonlyArray<Call>,
  extra2: ReadonlyArray<string>,
  stored1: Stored,
  stored2: Stored,
): Graded => {
  const saved = Object.fromEntries(scenario.facts.map((fact) => [fact.id, stored1.documents.some((document) => holds(fact, document))]))
  const firstAct = calls2.findIndex((call) => !isMemory(call.name))
  const firstRead = calls2.findIndex(isRead)
  const u1 = units(scenario.facts, stored1)
  const u2 = units(scenario.facts, stored2)
  return {
    saved,
    correct: scenario.grade(calls2),
    readBeforeAct: firstRead !== -1 && (firstAct === -1 || firstRead < firstAct),
    readAny: firstRead !== -1,
    digest: extra2.some((text) => text.startsWith(HEADING)),
    writes1: calls1.filter(isWrite).length,
    writes2: calls2.filter(isWrite).length,
    units1: u1.count,
    units2: u2.count,
    offList1: u1.off,
    offList2: u2.off,
    taskState1: u1.taskState,
    taskState2: u2.taskState,
  }
}
