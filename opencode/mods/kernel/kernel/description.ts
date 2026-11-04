// What the model reads about the kernel tool, and the input it calls it with.
// The words are the model's contract: they change only on purpose.
import { Schema } from "effect"
import { MAX_DISPLAY_CHARS } from "./limits.ts"
import { catalog, type Reached } from "./tools.ts"

/** The kernel tool's input. */
export const KernelInput = Schema.Struct({
  code: Schema.String.annotate({ description: "TypeScript to run at the kernel's top level" }),
  reset: Schema.optional(Schema.Boolean).annotate({ description: "Drop every binding and start an empty kernel first" }),
})
export interface KernelInput extends Schema.Schema.Type<typeof KernelInput> {}

/** The limits the description names. */
export interface Limits {
  /** A call's compute limit, in ms. */
  readonly timeoutMs: number
  /** The characters of output the model sees per call. */
  readonly viewChars: number
}

const DIRECT_TOOLS = "Calling tools: `await tools.<id>(input)` runs any other tool this session offers, with the same input it takes as a direct call, and resolves to its result (its output, or its text). Permissions apply as for a direct call. `tools.list()` returns the ids and descriptions. A failed tool call throws; catch it to continue. Run independent calls together with Promise.all."

const RUNTIME_TOOLS = "Calling tools: the kernel is your only tool. Every other tool is a function on `tools`, listed below with its input: `await tools.<name>(input)` runs it and resolves to its result (its output, or its text). Read files, edit, run commands and start subagents from here. Permissions apply and a refused or failed call throws; catch it to continue. Run independent calls together with Promise.all, and print only what you need to read."

/** What the model reads about the kernel; `tools` when it is the runtime, which reaches them. */
export const description = (limits: Limits, tools?: ReadonlyArray<Reached>) => `Run TypeScript in a persistent kernel: one Bun process for this session.

What persists: top-level bindings (let, const, var, function, class) stay defined for the next kernel call in this session. They also survive a kernel restart: top-level imports and function and class declarations (const f = () => … included) run again from their source, each name at its latest version; then data comes back, cycles included: primitives and BigInt, plain objects, arrays, Map, Set, Date, RegExp, Buffer, typed arrays, errors (type, name, message) and instances of those classes, up to 16 MiB per binding and 256 MiB in all. Closures made inside a function, instances of classes with #private members, promises and other live objects do not. The result names each binding it dropped and why. reset: true starts an empty kernel.

The result is what the code printed (console.log and friends), then the value of its last expression. Top-level await works.

${tools === undefined ? DIRECT_TOOLS : RUNTIME_TOOLS}

Limits: ${limits.timeoutMs / 1000} s of compute per call, paused while tool calls run; past it the kernel is killed and bindings since the last call are lost. You see at most ${limits.viewChars.toLocaleString("en-US")} characters of output, its head and tail; ${MAX_DISPLAY_CHARS / 1024} KiB at most are kept. Keep large data in variables and print what you need.${tools === undefined ? `

Use the kernel to compute, to chain several tool calls, to transform or filter tool results, and to keep data between steps. Call a tool directly for a single call whose full result you want to read.` : `

## Tools

${catalog(tools)}`}`
