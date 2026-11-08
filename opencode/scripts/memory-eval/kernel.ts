// The `kernel` arm: memory as production reaches it. With `codeOnly` (the
// default) the kernel is an agent's only tool, and every other tool is one line
// of the kernel's description, called from a cell as `await tools.<name>(input)`.
//
// - The description is the real one (mods/kernel/description.ts) over the
//   real 50-tool catalog of 2026-11-08: the names and descriptions of
//   mods/kernel/catalog.fixture.ts, each line's input as production printed it
//   (kernel-inputs.ts), its summary the first sentence (summary.ts), the
//   shell's line from IN_A_CELL; memory's three lines rendered by the real
//   `catalog` from their real schemas.
// - A cell is TypeScript compiled as the worker compiles it (Bun.Transpiler in
//   replMode) and run in a vm context that persists for the session, so
//   top-level bindings carry over. `tools.list()`, `tools.docs(name)` and
//   `tools.docs.search(query)` answer as the worker's do. `tools.shell` resolves
//   to a handle (worker/shell-handle.ts) over the eval's fake shell; the memory
//   tools run on the arm's store; the eval's other fake tools answer as
//   direct calls do; every other catalog tool throws, unavailable here. A
//   failed call throws. The answer is what the cell printed, then its last
//   value, cut to viewChars, as answer.ts reads it.
// - What differs from production: the cell's `child_process`, `fs`, `Bun`
//   and `process` are small stand-ins over the fake world (hostModules), no
//   attach, no restarts.
import vm from "node:vm"
import { catalog as FIXTURE } from "../../mods/kernel/catalog.fixture.ts"
import { description, KernelInput } from "../../mods/kernel/description.ts"
import { viewOf } from "../../mods/kernel/output.ts"
import { firstSentence, searcher } from "../../mods/kernel/summary.ts"
import { catalog, docsOf, IN_A_CELL, pathOf } from "../../mods/kernel/tools.ts"
import { handleOf, makeShellHandle, runShell as cellShell, type ShellHandleData } from "../../mods/kernel/worker/shell-handle.ts"
import { KERNEL_INPUTS } from "./kernel-inputs.ts"
import { jsonSchemaOf } from "./memory.ts"
import { DISTRACTORS, SHELL, type ToolDef } from "./tools.ts"
import { HOME } from "./world.ts"

export const KERNEL_LIMITS = { timeoutMs: 30_000, viewChars: 8_000 } as const

/** The tools the eval's fake world answers; a cell's call of any other catalog tool throws. */
const ANSWERED: ReadonlySet<string> = new Set([SHELL.name, ...DISTRACTORS.map((tool) => tool.name)])

/** A tool as a cell lists it: its full words (`docsOf`) and, where the eval has one, its input schema. */
export interface Listed {
  readonly id: string
  readonly description: string
  readonly input?: unknown
}

/** The memory tools as the arm offers them: API tool entries with their JSON Schema. */
type MemoryTool = { readonly name: string; readonly description: string; readonly input_schema: Record<string, unknown> }

const isMemory = (name: string) => name.startsWith("memory_")

/** The catalog's lines: production's for every tool but memory's, memory's from their real schemas; sorted by name. */
export const catalogLines = (memory: ReadonlyArray<MemoryTool>): ReadonlyArray<string> => {
  const others = FIXTURE.filter((tool) => !isMemory(tool.id)).map((tool) => {
    const input = IN_A_CELL[tool.id]?.input ?? KERNEL_INPUTS[tool.id]
    if (input === undefined) throw new Error(`kernel-inputs.ts has no input for ${tool.id}`)
    return { name: tool.id, line: `- ${pathOf(tool.id)}(input: ${input}): ${IN_A_CELL[tool.id]?.line ?? firstSentence(tool.description)}` }
  })
  const ours = catalog(memory.map((tool) => ({ name: tool.name, description: tool.description, input: tool.input_schema })))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => ({ name: /^- tools\.(\w+)\(/.exec(line)![1]!, line }))
  return [...others, ...ours].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((entry) => entry.line)
}

/** The kernel tool as the model sees it, its description listing the catalog. */
export const kernelTool = (memory: ReadonlyArray<MemoryTool>): ToolDef => ({
  name: "kernel",
  description: description(KERNEL_LIMITS, []) + catalogLines(memory).join("\n"),
  input_schema: jsonSchemaOf(KernelInput as never),
})

/** What a cell lists: every catalog tool, with its docs and the input schema the eval knows. */
export const listingOf = (memory: ReadonlyArray<MemoryTool>): ReadonlyArray<Listed> => {
  const known = new Map<string, ToolDef>([SHELL, ...DISTRACTORS].map((tool) => [tool.name, tool]))
  const others = FIXTURE.filter((tool) => !isMemory(tool.id)).map((tool) => ({
    id: tool.id,
    description: docsOf(tool.id, tool.description),
    ...(known.has(tool.id) ? { input: known.get(tool.id)!.input_schema } : {}),
  }))
  return [...others, ...memory.map((tool) => ({ id: tool.name, description: tool.description, input: tool.input_schema }))]
}

export interface Answered {
  readonly output: string
  readonly error: boolean
}

/** One tool call from a cell, answered by the episode: its output, and whether it failed. The fake world answers at once; memory, by a promise. */
export type Dispatch = (name: string, input: Record<string, unknown>) => Answered | Promise<Answered>

/** A file's text from the read tool's numbered lines. */
const unnumbered = (text: string) => text.replace(/^\d+: /gm, "")

/**
 * What a cell reaches outside `tools` in production, over the fake world: a
 * real kernel is a Bun process, and models reach for `child_process`, `fs`,
 * `Bun.file` and `Bun.$` as often as for `tools.shell`. Each goes through the
 * episode as the matching tool (a command as `shell`, a file read as `read`,
 * a write as `write`), so the graders and the gotcha trigger see it.
 */
const hostModules = (
  cwd: string,
  answer: (name: string, input: Record<string, unknown>) => Answered,
  print: (text: string) => void,
): Record<string, Record<string, unknown>> => {
  const run = (command: string) => answer("shell", { command })
  const failure = (command: string, result: Answered) =>
    Object.assign(new Error(`Command failed: ${command}\n${result.output}`), { status: 1, stdout: result.output, stderr: result.output, exitCode: 1 })
  const execSync = (command: unknown, options?: { readonly stdio?: unknown }) => {
    const result = run(String(command))
    // stdio "inherit" sends the output to the process's own stdout, which the kernel shows as the cell's output.
    const inherit = options?.stdio === "inherit"
    if (inherit) print(result.output)
    if (result.error) throw failure(String(command), result)
    return inherit ? null : result.output
  }
  const spawnSync = (command: unknown, args: unknown = []) => {
    const line = [String(command), ...(Array.isArray(args) ? args.map(String) : [])].join(" ")
    const result = run(line)
    return { status: result.error ? 1 : 0, stdout: result.output, stderr: "", output: [null, result.output, ""] }
  }
  const exec = (command: unknown, ...rest: Array<unknown>) => {
    const callback = rest.find((item) => typeof item === "function") as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    const result = run(String(command))
    queueMicrotask(() => callback?.(result.error ? failure(String(command), result) : null, result.output, ""))
  }
  const missing = (path: unknown) => Object.assign(new Error(`ENOENT: no such file or directory, open '${String(path)}'`), { code: "ENOENT" })
  const readFileSync = (path: unknown) => {
    const result = answer("read", { path: String(path) })
    if (result.error) throw missing(path)
    return unnumbered(result.output)
  }
  const writeFileSync = (path: unknown, content: unknown) => {
    const result = answer("write", { path: String(path), content: String(content) })
    if (result.error) throw new Error(result.output)
  }
  const existsSync = (path: unknown) => !answer("read", { path: String(path) }).error
  const readdirSync = (path: unknown) => readFileSync(path).split("\n").filter((line) => line !== "").map((line) => line.replace(/\/$/, ""))
  const fs = {
    readFileSync,
    writeFileSync,
    existsSync,
    readdirSync,
    promises: {
      readFile: async (path: unknown) => readFileSync(path),
      writeFile: async (path: unknown, content: unknown) => writeFileSync(path, content),
      readdir: async (path: unknown) => readdirSync(path),
    },
  }
  /** `Bun.$`: a template that runs one command line, throwing on a failure unless `.nothrow()`. */
  const shell = (strings: TemplateStringsArray, ...values: Array<unknown>) => {
    const command = strings.reduce((line, part, index) => line + part + (index < values.length ? String(values[index]) : ""), "")
    let thrown = true
    let result: Answered | undefined
    const done = () => {
      result ??= run(command)
      if (result.error && thrown) throw Object.assign(failure(command, result), { name: "ShellError" })
      return { exitCode: result.error ? 1 : 0, stdout: result.output, stderr: "", text: () => result!.output }
    }
    const pending = {
      quiet: () => pending,
      nothrow: () => ((thrown = false), pending),
      cwd: () => pending,
      env: () => pending,
      text: async () => done().stdout,
      lines: async () => done().stdout.split("\n"),
      // Bun.$ is awaited as it is: its promise is a thenable.
      // oxlint-disable-next-line unicorn/no-thenable
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
        try {
          return Promise.resolve(resolve(done()))
        } catch (error) {
          return Promise.resolve(reject(error))
        }
      },
    }
    return pending
  }
  const bun = {
    file: (path: unknown) => ({ text: async () => readFileSync(path), json: async () => JSON.parse(readFileSync(path)), exists: async () => existsSync(path) }),
    write: async (path: unknown, content: unknown) => writeFileSync(path, content),
    spawnSync: (argv: unknown) => {
      const result = spawnSync(Array.isArray(argv) ? argv.join(" ") : String(argv))
      return { exitCode: result.status, stdout: result.stdout, stderr: "", success: result.status === 0 }
    },
    $: shell,
    cwd,
  }
  const path = { join: (...parts: Array<unknown>) => parts.map(String).join("/").replace(/\/+/g, "/"), resolve: (...parts: Array<unknown>) => parts.map(String).join("/").replace(/\/+/g, "/") }
  return { child_process: { execSync, spawnSync, exec }, fs, "fs/promises": fs.promises, bun, path }
}

export interface CellAnswer {
  readonly ok: boolean
  readonly text: string
}

export interface Kernel {
  readonly run: (code: string, dispatch: Dispatch) => Promise<CellAnswer>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** A thrown value's words, as the worker's errorText gives an error's head. */
const errorText = (cause: unknown): string => {
  if (isRecord(cause) || cause instanceof Error) {
    const name = String(Reflect.get(cause, "name") ?? "Error")
    const message = String(Reflect.get(cause, "message") ?? "")
    return message === "" ? name : `${name}: ${message}`
  }
  return typeof cause === "string" ? cause : Bun.inspect(cause)
}

const display = (value: unknown): string => (typeof value === "string" ? value : Bun.inspect(value, { depth: 4 }))

/** A session's kernel: one vm context whose globals persist from cell to cell. */
export const newKernel = (listing: ReadonlyArray<Listed>, cwd: string): Kernel => {
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "node", replMode: true })
  const ids = listing.map((tool) => tool.id)
  const search = searcher(listing)
  let output: Array<string> = []
  let dispatch: Dispatch | undefined
  const handles = new Map<string, ShellHandleData>()

  const write = (...values: Array<unknown>) => void output.push(values.map(display).join(" "))
  const notHere = (id: string) => new Error(`${pathOf(id)} is not a tool here. Tools: ${ids.map(pathOf).sort().join(", ")}`)

  const call = async (id: string, input: unknown): Promise<unknown> => {
    if (dispatch === undefined) throw new Error("A tool call from a cell that has ended")
    const given = input === undefined ? {} : (JSON.parse(JSON.stringify(input)) as unknown)
    if (!ANSWERED.has(id) && !isMemory(id)) throw new Error(`${id} is unavailable in this session`)
    if (!isRecord(given)) throw new Error(`Invalid arguments for tool "${id}": expected an object`)
    if (id === "shell") {
      // A handle method (check, wait, kill) on a command that has already exited: its state, nothing new to show.
      if (typeof given["action"] === "string") {
        const known = handles.get(String(given["id"]))
        if (known === undefined) throw new Error(`No shell ${String(given["id"])} in this session`)
        return { ...known, output: "" }
      }
      const answer = await dispatch("shell", given)
      const data: ShellHandleData = { id: `sh_${handles.size + 1}`, state: "exited", exitCode: answer.error ? 1 : 0, runtimeMs: 40, output: answer.output, next: answer.output.length, truncated: false }
      handles.set(data.id, data)
      return data
    }
    const answer = await dispatch(id, given)
    if (answer.error) throw new Error(answer.output)
    return answer.output
  }
  const shellCall = (input: unknown) => call("shell", input) as Promise<never>

  const docs = Object.assign(
    (name: unknown) => {
      const tool = listing.find((item) => item.id === String(name))
      if (tool === undefined) throw notHere(String(name))
      return { name: tool.id, description: tool.description, ...(tool.input === undefined ? {} : { input: tool.input }) }
    },
    { search: (query: unknown, limit?: unknown) => search(String(query ?? ""), typeof limit === "number" ? limit : undefined).map(({ name, summary }) => ({ name, summary })) },
  )
  const shellNamespace = {
    handle: (id: unknown) => handleOf(id, shellCall),
    list: async () => [...handles.values()].map((data) => makeShellHandle({ ...data, output: "" }, shellCall)),
  }
  const node = (id: string) =>
    new Proxy((input?: unknown) => (id === "shell" ? cellShell(input, shellCall) : call(id, input)), {
      get: (target, key) => (id === "shell" && typeof key === "string" && key in shellNamespace ? shellNamespace[key as keyof typeof shellNamespace] : Reflect.get(target, key)),
    })
  const lookup = (id: unknown) => {
    if (!ids.includes(String(id))) throw notHere(String(id))
    return node(String(id))
  }
  const tools = new Proxy(lookup, {
    get: (target, key) => {
      if (key === "list") return () => listing.map(({ id, description }) => ({ id, description }))
      if (key === "docs") return docs
      if (typeof key !== "string" || key === "then" || key === "toJSON") return Reflect.get(target, key)
      if (ids.includes(key)) return node(key)
      throw notHere(key)
    },
  })
  const console = { log: write, info: write, warn: write, error: write, debug: write, dir: write, table: write }
  const modules = hostModules(cwd, (name, input) => {
    if (dispatch === undefined) throw new Error("A call from a cell that has ended")
    const answer = dispatch(name, input)
    if (answer instanceof Promise) throw new Error(`${name} cannot answer synchronously`)
    return answer
  }, write)
  const load = (name: unknown) => {
    const found = modules[String(name).replace(/^node:/, "")]
    if (found === undefined) throw new Error(`Cannot find module '${String(name)}'`)
    return found
  }
  const context = vm.createContext({
    tools,
    console,
    attach: () => {
      throw new Error("attach: no images in this session")
    },
    require: load,
    __import: async (name: unknown) => ({ ...load(name), default: load(name) }),
    Bun: modules["bun"],
    process: {
      cwd: () => cwd,
      env: { HOME, PWD: cwd },
      platform: "darwin",
      exit: (code?: unknown) => {
        throw new Error(`The kernel's process exited (process.exit(${String(code ?? 0)})); its bindings are lost`)
      },
    },
    setTimeout,
    clearTimeout,
  })

  return {
    run: async (code, given) => {
      output = []
      dispatch = given
      let ok = true
      try {
        // replMode turns each import into `await import(...)`; a cell's imports reach the host modules below.
        const compiled = transpiler.transformSync(code).replace(/\bimport\(/g, "__import(")
        let result: unknown = vm.runInContext(compiled, context, { timeout: 5_000 })
        // replMode wraps the cell in an async function: its promise resolves to `{ value }` of the last expression.
        if (typeof (result as { then?: unknown } | undefined)?.then === "function") result = await (result as Promise<unknown>)
        const value = isRecord(result) ? Object.getOwnPropertyDescriptor(result, "value")?.value : undefined
        if (value !== undefined) output.push(display(value))
      } catch (cause) {
        ok = false
        output.push(errorText(cause))
      } finally {
        dispatch = undefined
      }
      const text = output.join("\n")
      return { ok, text: viewOf(text === "" ? "(no output)" : text, KERNEL_LIMITS.viewChars) }
    },
  }
}
