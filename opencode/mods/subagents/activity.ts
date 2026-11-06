// What a subagent is doing, in a few words: its running call as the Prime
// transcript's tree row says it (`running bun test`, `editing src/money.ts`;
// a shell call by its own description, else in a few words, never its whole
// one-liner), else the latest sentence it wrote, thought or put in its queue.
import type { Call, Message } from "./family.ts"
import { brief, shellAction, type ShellAction, waitsInput } from "./shell.ts"

/** The host's name for a tool, whatever the model called it (the host's `canonicalToolName`). */
export function canonical(name: string): string {
  if (name === "bash") return "shell"
  if (name === "task") return "subagent"
  if (name === "apply_patch") return "patch"
  return name
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/** The one input field that best stands for the call. */
function source(tool: string, input: Readonly<Record<string, unknown>>): string {
  if (tool === "shell") return text(input.command) ?? ""
  if (tool === "patch") return text(input.patchText) ?? ""
  if (tool === "read" || tool === "edit" || tool === "write") return text(input.path) ?? text(input.filePath) ?? ""
  if (tool === "glob") return text(input.pattern) ?? ""
  if (tool === "subagent") return text(input.prompt) ?? text(input.description) ?? ""
  return Object.entries(input)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ")
}

/** The source on one line: a patch's files, else its first line, an ellipsis when more follow. */
function preview(tool: string, input: Readonly<Record<string, unknown>>): string {
  if (tool === "patch") {
    const files = [...source(tool, input).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1])
    if (files.length) return files.join(", ")
  }
  const [first = "", ...rest] = source(tool, input).trim().split("\n")
  return rest.some((line) => line.trim()) ? `${first}…` : first
}

/** What the call touches, as the transcript row's subject. */
function subject(tool: string, input: Readonly<Record<string, unknown>>): string {
  if (tool === "grep") {
    const path = typeof input.path === "string" ? ` in ${input.path}` : ""
    return `/${String(input.pattern ?? "")}/${path}`
  }
  if (tool === "subagent") {
    const described = text(input.description)?.trim()
    if (described) return described
    const name = text(input.agent) ?? "subagent"
    const task = preview(tool, input)
    return task ? `${name} · ${task}` : name
  }
  return preview(tool, input)
}

const VERBS: Readonly<Record<string, readonly [running: string, past: string]>> = {
  read: ["reading", "read"],
  grep: ["searching", "searched"],
  glob: ["searching", "searched"],
  websearch: ["searching", "searched"],
  webfetch: ["fetching", "fetched"],
  patch: ["editing", "edited"],
  edit: ["editing", "edited"],
  write: ["writing", "wrote"],
  shell: ["running", "ran"],
  subagent: ["running", "ran"],
  question: ["asking", "asked"],
}

/** A shell call on the session's shells, in the tense of its status: `waiting on sh_1`, `killed sh_1`, `listed shells`. */
const SHELL_ACTIONS: Readonly<Record<Exclude<ShellAction, "run">, readonly [running: string, past: string]>> = {
  check: ["checking", "checked"],
  wait: ["waiting on", "waited on"],
  kill: ["killing", "killed"],
  list: ["listing", "listed"],
}

/** Whether a call still runs: streaming its input or running. */
export const running = (call: Call) => call.status === "streaming" || call.status === "running"

const described = (call: Call) => text(call.input.description)?.replace(/\s+/g, " ").trim() || undefined

/** The tool a kernel cell runs now: the latest of its record's calls still running. */
const inner = (call: Call) => (canonical(call.tool) === "kernel" ? call.calls?.findLast(running) : undefined)

/**
 * Whether a call, while it runs, only waits: a shell call whose description
 * or command waits (shell.ts), or a kernel cell running one.
 */
export function waiting(call: Call): boolean {
  if (!running(call)) return false
  const nested = inner(call)
  if (nested) return waiting(nested)
  return waits(call)
}

/** Whether a call is one that only waits, whatever its status: a shell call whose description or command waits. */
export const waits = (call: Call) => canonical(call.tool) === "shell" && waitsInput(call.input)

/**
 * What a call does or did, in the tense of its status: `running bun test`,
 * `edited src/money.ts`. A shell call reads as its own description when it
 * gave one, a wait as what it waits on (`polling gate.log`, `sleep 600`),
 * else its main command in a few words. A kernel cell reads as its
 * description, else the tool it runs now, else its first line of code, a
 * leading comment's words when it opens with one.
 */
export function activity(call: Call): string {
  const tool = canonical(call.tool)
  if (tool === "kernel") {
    const nested = inner(call)
    if (described(call) === undefined && nested) return activity(nested)
    if (described(call)) return described(call) ?? ""
    const code = text(call.input.code) ?? ""
    const first = code.split("\n").find((line) => line.trim()) ?? ""
    return `kernel: ${first.trim().replace(/^\/\/\s*|^\/\*\s*|\s*\*\/$/g, "")}`.trimEnd()
  }
  if (tool === "shell" && shellAction(call.input) !== "run") {
    const action = shellAction(call.input)
    const [now, past] = SHELL_ACTIONS[action as Exclude<ShellAction, "run">]
    const target = action === "list" ? "shells" : (text(call.input.id) ?? "")
    return [running(call) ? now : past, target].filter(Boolean).join(" ")
  }
  if (tool === "shell") {
    const own = described(call)
    if (own) return own
    const short = brief(text(call.input.command) ?? "")
    if (waitsInput(call.input)) return short
    return [running(call) ? "running" : "ran", short].filter(Boolean).join(" ")
  }
  if (tool === "queue") return said(call) ?? "updated its queue"
  const verbs = VERBS[tool]
  const verb = verbs ? (running(call) ? verbs[0] : verbs[1]) : tool
  return [verb, subject(tool, call.input)].filter(Boolean).join(" ")
}

/** The first sentence of some prose: up to its first `.`, `!` or `?` that ends a word, else all of it. */
export function firstSentence(prose: string): string {
  const flat = prose.replace(/\s+/g, " ").trim()
  const end = /[.!?](?=\s|$)/.exec(flat)
  return end ? flat.slice(0, end.index + 1) : flat
}

const isQueue = (call: Call) => canonical(call.tool) === "queue"

/**
 * The one line a `queue` call says about the work: the text of the item it
 * set or upserted that runs or waits, else of its first one.
 */
export function said(call: Call): string | undefined {
  const items = [...list(call.input.set), ...list(call.input.upsert)].flatMap((item) =>
    item !== null && typeof item === "object" && !Array.isArray(item) ? [Object.fromEntries(Object.entries(item))] : [],
  )
  const live = items.find((item) => item.state === "running" || item.state === "waiting") ?? items[0]
  const line = text(live?.text)?.replace(/\s+/g, " ").trim()
  return line ? firstSentence(line) : undefined
}

const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

/** Something a subagent wrote or did: its words, its queue's update, or another call; `index` its place among them. */
export type Said =
  | { readonly type: "sentence"; readonly text: string; readonly at?: number; readonly index: number }
  | { readonly type: "call"; readonly call: Call; readonly index: number }

/** Everything a session's steps wrote or did, in order: each step's words and calls (a kernel call as one, its queue updates after it). */
export const sayings = once((messages: ReadonlyArray<Message>): ReadonlyArray<Said> => {
  const out: Said[] = []
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.parts) {
      const index = out.length
      if (part.type === "words") {
        const words = part.text.replace("[REDACTED]", "").trim()
        if (words) out.push({ type: "sentence", text: firstSentence(words), ...(part.at === undefined ? {} : { at: part.at }), index })
        continue
      }
      const at = part.started === undefined ? {} : { at: part.started }
      const queued = isQueue(part) && part.status === "completed" ? said(part) : undefined
      out.push(queued === undefined ? { type: "call", call: part, index } : { type: "sentence", text: queued, ...at, index })
      // A kernel cell's own queue updates follow the cell.
      for (const nested of part.calls ?? []) {
        const text = isQueue(nested) && nested.status === "completed" ? said(nested) : undefined
        if (text !== undefined) out.push({ type: "sentence", text, ...at, index: out.length })
      }
    }
  }
  return out
})

/** The latest sentence it wrote, thought or put in its queue, if any. */
export const lastSentence = (all: ReadonlyArray<Said>) => all.findLast((item) => item.type === "sentence")

/**
 * A value worked out once per object: the family keeps a `Message` and an
 * unchanged session's `messages` array as the same object across updates
 * (solid/reader.ts), so a token re-works the values of its own message and
 * session alone.
 */
export function once<K extends object, V>(of: (key: K) => V): (key: K) => V {
  const known = new WeakMap<K, { readonly value: V }>()
  return (key) => {
    const hit = known.get(key)
    if (hit !== undefined) return hit.value
    const value = of(key)
    known.set(key, { value })
    return value
  }
}

const newest = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.max(a, b))

/** The newest time among one message's words and calls. */
const heardIn = once((message: Message): number | undefined => {
  if (message.type !== "assistant") return undefined
  let at: number | undefined
  for (const part of message.parts) at = part.type === "words" ? newest(at, part.at) : newest(newest(at, part.started), part.completed)
  return at
})

/** When it last wrote or did anything, if the data says: the newest time among its words and calls. */
export const lastHeard = once((messages: ReadonlyArray<Message>): number | undefined => {
  let at: number | undefined
  for (const message of messages) at = newest(at, heardIn(message))
  return at
})

/** The call a subagent runs now: its newest step's latest running call. */
export function liveCall(messages: ReadonlyArray<Message>): Call | undefined {
  const newest = messages.findLast((message) => message.type === "assistant")
  return newest?.type === "assistant" ? newest.parts.findLast((part): part is Call => part.type === "call" && running(part)) : undefined
}

/**
 * The update while a subagent's turn runs: the call it runs now, unless it
 * wrote a sentence after starting it; else its latest sentence (words,
 * thought or queue item); else its latest ended call; `starting` before it
 * has done anything.
 */
export const runningUpdate = once((messages: ReadonlyArray<Message>): string => {
  const all = sayings(messages)
  const live = liveCall(messages)
  const sentence = lastSentence(all)
  const at = live ? all.findIndex((item) => item.type === "call" && item.call === live) : -1
  if (live && !(sentence && sentence.index > at)) return activity(live)
  if (sentence?.type === "sentence") return sentence.text
  const ended = all.findLast((item) => item.type === "call")
  return ended?.type === "call" ? activity(ended.call) : "starting"
})
