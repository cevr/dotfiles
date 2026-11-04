/**
 * The code kernel as an OpenCode server plugin, ported from gent's `cell` tool.
 *
 * - `kernel({ code, reset? })` runs TypeScript in a Bun worker that lives as
 *   long as its session, so top-level bindings persist between calls. The
 *   result is what the code printed, then its last expression's value.
 * - Inside the code, `await tools.<id>(input)` runs another OpenCode tool
 *   through its own `execute`, with the kernel call's context: the tool asks
 *   for permission and stops on abort as for a direct call (host-tools.ts).
 * - One worker per session, started on the first call. It is killed when the
 *   session is deleted, after `idleMs` without a call, on abort, and past the
 *   compute limit. After every call the JSON-safe bindings are stored under the
 *   session; a new worker starts with them, and `reset` drops them.
 * - The kernel is a direct tool (`codemode: false`). With `denyExecute`, every
 *   agent the plugins define denies code mode's `execute`, so the kernel is the
 *   only code tool and every other tool is offered directly too.
 *
 * Options (all optional):
 * - `idleMs`: kill a session's worker after this long without a call; default 1,800,000 (30 min).
 * - `timeoutMs`: a call's compute limit, paused while its tool calls run; default 30,000.
 * - `viewChars`: the characters of output the model sees per call; default 8,000.
 * - `denyExecute`: deny code mode's `execute` to every agent; default true.
 *
 * @module
 */
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { callable, callTool, listing, type HostContext, type Rule } from "./host-tools.ts"
import { Kernel } from "./kernel.ts"
import { MAX_DISPLAY_CHARS, viewOf, type Omission, type SnapshotBinding } from "./protocol.ts"

export const DEFAULTS = { idleMs: 30 * 60_000, timeoutMs: 30_000, viewChars: 8_000, denyExecute: true } as const
const STORAGE_PREFIX = "kernel:"

export interface Options {
  readonly idleMs: number
  readonly timeoutMs: number
  readonly viewChars: number
  readonly denyExecute: boolean
}

const positive = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback

/** The plugin's options, each falling back to its default when absent or invalid. */
export const readOptions = (options: Plugin.Context["options"]): Options => ({
  idleMs: positive(options.idleMs, DEFAULTS.idleMs),
  timeoutMs: positive(options.timeoutMs, DEFAULTS.timeoutMs),
  viewChars: positive(options.viewChars, DEFAULTS.viewChars),
  denyExecute: typeof options.denyExecute === "boolean" ? options.denyExecute : DEFAULTS.denyExecute,
})

/** What the model reads about the kernel. */
export const description = (options: Options) => `Run TypeScript in a persistent kernel: one Bun process for this session.

What persists: top-level bindings (let, const, var, function, class) stay defined for the next kernel call in this session. Data also survives a kernel restart, cycles included: primitives and BigInt, plain objects, arrays, Map, Set, Date, RegExp, Buffer, typed arrays and errors (type, name, message), up to 16 MiB per binding and 256 MiB in all. Functions, classes and their instances, imports, promises and other live objects do not: after a restart, declare and import them again. The result names each binding it dropped and why. reset: true starts an empty kernel.

The result is what the code printed (console.log and friends), then the value of its last expression. Top-level await works.

Calling tools: \`await tools.<id>(input)\` runs any other tool this session offers, with the same input it takes as a direct call, and resolves to its result (its output, or its text). Permissions apply as for a direct call. \`tools.list()\` returns the ids and descriptions. A failed tool call throws; catch it to continue. Run independent calls together with Promise.all.

Limits: ${options.timeoutMs / 1000} s of compute per call, paused while tool calls run; past it the kernel is killed and bindings since the last call are lost. You see at most ${options.viewChars.toLocaleString("en-US")} characters of output, its head and tail; ${MAX_DISPLAY_CHARS / 1024} KiB at most are kept. Keep large data in variables and print what you need.

Use the kernel to compute, to chain several tool calls, to transform or filter tool results, and to keep data between steps. Call a tool directly for a single call whose full result you want to read.`

const Input = Schema.Struct({
  code: Schema.String.annotate({ description: "TypeScript to run at the kernel's top level" }),
  reset: Schema.optional(Schema.Boolean).annotate({ description: "Drop every binding and start an empty kernel first" }),
})

/** A session's stored bindings. */
interface Stored {
  readonly bindings: ReadonlyArray<SnapshotBinding>
}

const isStored = (value: unknown): value is Stored =>
  typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "bindings"))

/** A session's worker and what keeps its calls in order. */
interface Session {
  kernel?: Kernel
  idle?: ReturnType<typeof setTimeout>
  queue: Promise<unknown>
}

const omissionNote = (omitted: ReadonlyArray<Omission>, bound: ReadonlyArray<string>) => {
  const named = omitted.filter((item) => bound.includes(item.name))
  if (named.length === 0) return undefined
  return `[not kept across restarts: ${named.map((item) => `${item.name} (${item.reason})`).join(", ")}]`
}

export const kernel = () =>
  Plugin.define({
    id: "dotfiles-opencode.kernel",
    setup: async (ctx) => {
      const options = readOptions(ctx.options)
      const sessions = new Map<string, Session>()
      const background = new AbortController()

      const sessionOf = (sessionID: string) => {
        const existing = sessions.get(sessionID)
        if (existing) return existing
        const created: Session = { queue: Promise.resolve() }
        sessions.set(sessionID, created)
        return created
      }
      const stop = (sessionID: string) => {
        const session = sessions.get(sessionID)
        if (!session) return
        if (session.idle) clearTimeout(session.idle)
        session.kernel?.kill()
        session.kernel = undefined
      }
      const storageKey = (sessionID: string) => STORAGE_PREFIX + sessionID

      /** The session's working directory and the permission rules its tools are filtered by. */
      const scope = async (context: HostContext) => {
        const session = await ctx.session.get({ sessionID: context.sessionID })
        const directory = session.location.directory
        const agent = await ctx.agent.get({ agentID: context.agent, location: { directory } }).catch(() => undefined)
        const rules: ReadonlyArray<Rule> = [...(agent?.data.permissions ?? []), ...(session.permissions ?? [])]
        return { directory, rules }
      }

      /** The session's live worker, or a new one with the stored bindings; notes say what happened. */
      const worker = async (session: Session, sessionID: string, directory: string, notes: string[]) => {
        if (session.kernel?.alive) return session.kernel
        const started = await Kernel.start({ cwd: directory, timeoutMs: options.timeoutMs })
        session.kernel = started
        const stored = await ctx.storage.get(storageKey(sessionID)).catch(() => undefined)
        if (isStored(stored) && stored.bindings.length > 0) {
          const names = await started.restore(stored.bindings)
          notes.push(`[new kernel; restored ${names.join(", ")}]`)
        }
        return started
      }

      const run = async (code: string, reset: boolean, context: HostContext) => {
        const session = sessionOf(context.sessionID)
        if (session.idle) clearTimeout(session.idle)
        const notes: string[] = []
        if (reset) {
          stop(context.sessionID)
          await ctx.storage.remove(storageKey(context.sessionID))
          notes.push("[kernel reset]")
        }
        const { directory, rules } = await scope(context)
        const tools = callable(await ctx.tool.list(), rules)
        const current = await worker(session, context.sessionID, directory, notes)
        // Inner tools must not replace the kernel call's own progress.
        const inner: HostContext = { ...context, progress: async () => {} }
        let result
        try {
          result = await current.evaluate(code, listing(tools), (id, input) => callTool(tools, id, input, inner), context.signal)
        } catch (cause) {
          // The worker is gone; the next call starts a new one from the stored bindings.
          session.kernel = undefined
          throw new Error([...notes, cause instanceof Error ? cause.message : String(cause)].join("\n"))
        }
        if (current.alive) {
          const snapshot = await current.snapshot()
          const stored = { bindings: snapshot.bindings.map(({ name, value }) => ({ name, value })) }
          await ctx.storage.set(storageKey(context.sessionID), stored)
          const note = omissionNote(snapshot.omitted, result.bindings)
          if (note) notes.push(note)
          session.idle = setTimeout(() => stop(context.sessionID), options.idleMs)
        }
        const text = [...notes, result.output.trimEnd(), result.display].filter((part) => part !== "").join("\n")
        const view = viewOf(text === "" ? "(no output)" : text, options.viewChars)
        if (!result.ok) throw new Error(view)
        return view
      }

      await ctx.tool.transform((editor) => {
        editor.add({
          name: "kernel",
          description: description(options),
          input: Input,
          options: { codemode: false },
          execute: (input, context) => {
            const session = sessionOf(context.sessionID)
            // One call at a time per session: parallel calls share one worker.
            const next = session.queue.then(() => run(input.code, input.reset === true, context))
            session.queue = next.catch(() => undefined)
            return next.then((text) => ({ content: text }))
          },
        })
      })

      if (options.denyExecute)
        await ctx.agent.transform((editor) => {
          for (const agent of editor.list())
            editor.update(agent.id, (item) => {
              item.permissions.push({ action: "execute", resource: "*", effect: "deny" })
            })
        })

      void (async () => {
        for await (const event of ctx.event.subscribe({ types: ["session.deleted"], signal: background.signal })) {
          const sessionID = event.data.sessionID
          stop(sessionID)
          sessions.delete(sessionID)
          await ctx.storage.remove(storageKey(sessionID)).catch(() => undefined)
        }
      })().catch(() => undefined)

      return async () => {
        background.abort()
        for (const sessionID of sessions.keys()) stop(sessionID)
        sessions.clear()
      }
    },
  })

export default kernel()
