// What the model reads about the kernel tool, and the input it calls it with.
// The words are the model's contract: they change only on purpose.
import { Schema } from "effect"
import { MAX_DISPLAY_CHARS } from "./limits.ts"
import { catalog, IMAGE_NOTE, type Reached } from "./tools.ts"

/**
 * The kernel tool's input. `description` is the model's own label for the
 * cell, which the transcript shows as the call's header; it is optional, so
 * a call made before it existed still decodes.
 */
export const KernelInput = Schema.Struct({
  code: Schema.String.annotate({ description: "TypeScript to run at the kernel's top level" }),
  description: Schema.optional(Schema.String).annotate({
    description:
      'A few words in the present tense saying what this cell does, shown to the user as its header, e.g. "Merge the skill-dollar worker". Give one whenever the cell calls tools or changes anything; leave it out for a quick computation.',
  }),
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

const DOCS = "Read a tool's docs before its first call: `tools.docs(name)` returns its full description and input schema, and `tools.docs.search(query)` ranks the tools by a query, each with its first sentence."

const DIRECT_TOOLS = `Calling tools: \`await tools.<id>(input)\` runs any other tool this session offers, with the same input it takes as a direct call, and resolves to its result (its output, or its text). Permissions apply as for a direct call. \`tools.list()\` returns the ids and descriptions. ${DOCS} A failed tool call throws; catch it to continue. Run independent calls together with Promise.all.`

const RUNTIME_TOOLS = `Calling tools: the kernel is your only tool. Every other tool is a function on \`tools\`, listed below with its input and the first sentence of its description: \`await tools.<name>(input)\` runs it and resolves to its result (its output, or its text). ${DOCS} Read files, edit, run commands and start subagents from here. Permissions apply and a refused or failed call throws; catch it to continue. A tool that joins or leaves later is announced in a message; this list stays as it is. Run independent calls together with Promise.all, and print only what you need to read.`

const ATTACH = `Seeing images: \`attach(...paths: string[])\` shows image files (PNG, JPEG, GIF, WebP; a relative path is under the working directory) to you after this call, the way a pasted image is. An image a tool returns reaches your code as \`${JSON.stringify({ type: "image", mime: "image/png", name: "<path>", note: IMAGE_NOTE })}\`, not as its data.`

/** What the model reads about the kernel; `tools` when it is the runtime, which reaches them. */
export const description = (limits: Limits, tools?: ReadonlyArray<Reached>) => `Run TypeScript in a persistent kernel: one Bun process for this session.

What persists: top-level bindings (let, const, var, function, class) stay defined for the next kernel call in this session. They also survive a kernel restart: top-level imports and function and class declarations (const f = () => … included) run again from their source, each name at its latest version; then data comes back, cycles included: primitives and BigInt, plain objects, arrays, Map, Set, Date, RegExp, Buffer, typed arrays, errors (type, name, message) and instances of those classes, up to 16 MiB per binding and 256 MiB in all. Closures made inside a function, instances of classes with #private members, promises and other live objects do not. The result names each binding it dropped and why. reset: true starts an empty kernel.

The result is what the code printed (console.log and friends), then the value of its last expression. Top-level await works.

Describing a call: description is a few words in the present tense saying what the cell does ("Merge the skill-dollar worker", "Run the failing tests"); the user sees it as the call's header, over the tool calls the cell made. Give one whenever the cell calls tools or changes anything; leave it out for a quick computation.

${ATTACH}

${tools === undefined ? DIRECT_TOOLS : RUNTIME_TOOLS}

Limits: ${limits.timeoutMs / 1000} s of compute per call, paused while tool calls run; past it the kernel is killed and bindings since the last call are lost. You see at most ${limits.viewChars.toLocaleString("en-US")} characters of output, its head and tail; ${MAX_DISPLAY_CHARS / 1024} KiB at most are kept. Keep large data in variables and print what you need.${tools === undefined ? `

Use the kernel to compute, to chain several tool calls, to transform or filter tool results, and to keep data between steps. Call a tool directly for a single call whose full result you want to read.` : `

## Tools

${catalog(tools)}`}`
