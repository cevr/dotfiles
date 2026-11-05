// What a subagent is doing, in a few words: its running call as the Prime
// transcript's tree row says it (`running bun test`, `editing src/money.ts`),
// else the first sentence it last wrote or thought.
import type { Call, Message } from "./family.ts"

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

/** Whether a call still runs: streaming its input or running. */
export const running = (call: Call) => call.status === "streaming" || call.status === "running"

/**
 * What a call does or did, in the tense of its status: `running sh
 * check.sh`, `edited src/money.ts`. A kernel cell reads as its first line of
 * code, a leading comment's words when it opens with one.
 */
export function activity(call: Call): string {
  const tool = canonical(call.tool)
  if (tool === "kernel") {
    const code = text(call.input.code) ?? ""
    const first = code.split("\n").find((line) => line.trim()) ?? ""
    return `kernel: ${first.trim().replace(/^\/\/\s*|^\/\*\s*|\s*\*\/$/g, "")}`.trimEnd()
  }
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

/**
 * The update while a subagent runs: its newest step's running call (the
 * latest when several run), else the first sentence of its latest words,
 * else its latest ended call; `starting` before it has done anything.
 */
export function runningUpdate(messages: ReadonlyArray<Message>): string {
  const steps = messages.flatMap((message) => (message.type === "assistant" ? [message.parts] : []))
  const calls = (parts: (typeof steps)[number]) => parts.flatMap((part) => (part.type === "call" ? [part] : []))
  const newest = steps.at(-1)
  const live = newest && calls(newest).findLast(running)
  if (live) return activity(live)
  for (const parts of steps.toReversed())
    for (const part of parts.toReversed()) {
      const words = part.type === "words" ? part.text.replace("[REDACTED]", "").trim() : ""
      if (words) return firstSentence(words)
    }
  const ended = steps.flatMap(calls).at(-1)
  return ended ? activity(ended) : "starting"
}
