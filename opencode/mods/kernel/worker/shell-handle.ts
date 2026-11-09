/**
 * The shell inside a cell: `await tools.shell({ command })` runs a command and
 * resolves to a live handle, and the handle's methods act on it. The shell
 * tool's actions that act on a shell (`{ action: "check", id }`,
 * `{ action: "wait", id, ms }`, `{ action: "kill", id }`,
 * `{ action: "list" }`) stay the model's direct tool input; in a cell they are
 * methods: `.refresh()`, `.read()`, `.wait(ms)`, `.kill()`,
 * `tools.shell.list()`, `tools.shell.handle(id)`, which call the tool with
 * those actions underneath.
 *
 * A handle is the shell tool's handle (`{ id, state, exitCode?, signal?,
 * runtimeMs, output, next, truncated, backgrounded? }`) as a live object. Its
 * data fields are plain and enumerable, so it prints, serializes and survives
 * a kernel restart as data; its methods are not enumerable, so a restart drops
 * them, and `tools.shell.handle(id)` builds a live one again.
 *
 * Each method calls the shell tool with the handle's id, writes the handle it
 * returns into this one, and resolves to this one. `output` is the output the
 * handle has seen, newest last (up to `MAX_HANDLE_OUTPUT_CHARS`), or what
 * `read({ offset | lines })` asked for. The tool shows what is new since the
 * last look, and in a cell that look is the cell's own call, not the model's:
 * a `wait()` after a run that already showed everything sees nothing new. So
 * `refresh`, `wait`, `kill` and a bare `read` add what they see to the output
 * the handle holds when it continues from there (`next`), and replace it when
 * it does not (another handle on the same shell read in between).
 *
 * @module
 */
import type { Json } from "../frame.ts"

/** How long `wait()` without a limit waits: the shell tool's own foreground limit. */
export const DEFAULT_WAIT_MS = 10 * 60 * 1_000

/** The fields of a handle's state, as the shell tool gives them in a handle and in a list. */
interface ShellState {
  readonly id: string
  readonly state: "running" | "exited" | "killed"
  readonly exitCode?: number
  readonly signal?: string
  readonly timedOut?: boolean
  readonly runtimeMs: number
}

/** The shell tool's handle, as JSON. */
export interface ShellHandleData extends ShellState {
  readonly output: string
  readonly next: number
  readonly truncated: boolean
  readonly backgrounded?: "start" | "limit" | "user"
}

/** A live handle: the data, updated in place by each method. */
export interface ShellHandle extends ShellHandleData {
  /** The output from byte `offset` (a handle's `next`), or the last `lines` lines; else adds what is new. */
  read(options?: { readonly offset?: number; readonly lines?: number }): Promise<ShellHandle>
  /** Waits up to `ms` for the command to end. */
  wait(ms?: number): Promise<ShellHandle>
  /** Stops the command: SIGTERM to its process group, SIGKILL 3 s later. No end notice follows. */
  kill(): Promise<ShellHandle>
  /** Its state now, and adds the output that is new since the last look. */
  refresh(): Promise<ShellHandle>
}

/** A handle `tools.shell.list()` gives: also what the list says of the shell. */
export interface ListedShellHandle extends ShellHandle {
  readonly description: string
  readonly command: string
  /** Unix milliseconds. */
  readonly started: number
  readonly background: boolean
}

/** Calls the shell tool with an input (made JSON on the way) and resolves to its result. */
export type CallShell = (input: unknown) => Promise<Json>

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isShellState = (value: unknown): value is ShellState =>
  record(value) &&
  typeof value.id === "string" &&
  value.id.startsWith("sh_") &&
  typeof value.state === "string" &&
  typeof value.runtimeMs === "number"

/** Whether a shell result is a handle. */
export const isShellHandle = (value: unknown): value is ShellHandleData =>
  isShellState(value) && typeof Reflect.get(value, "output") === "string"

const method = (handle: object, name: string, value: (...args: never[]) => unknown) =>
  Object.defineProperty(handle, name, { value, writable: true, enumerable: false, configurable: true })

/** `data` as a live handle whose methods reach the shell tool through `call`. */
export const makeShellHandle = <Data extends ShellHandleData>(data: Data, call: CallShell): Data & ShellHandle => {
  const handle = { ...data } as Data & ShellHandle
  // `follow`: the call shows what is new since the last look, which goes after the output this handle holds when
  // it starts where that output ends; else the call's output is what it asked for, and replaces it.
  const update = async (input: Record<string, Json>, follow: boolean): Promise<ShellHandle> => {
    const result = await call({ ...input, id: handle.id })
    if (!isShellHandle(result)) throw new Error(`The shell tool did not return a handle for ${handle.id}`)
    const continues = follow && result.next - byteLength(result.output) === handle.next
    Object.assign(handle, result, continues ? kept(handle.output + result.output, handle.truncated || result.truncated) : {})
    return handle
  }
  method(handle, "read", (options?: { readonly offset?: number; readonly lines?: number }) =>
    update(
      {
        action: "check",
        ...(options?.offset === undefined ? {} : { offset: options.offset }),
        ...(options?.lines === undefined ? {} : { lines: options.lines }),
      },
      options?.offset === undefined && options?.lines === undefined,
    ),
  )
  method(handle, "wait", (ms?: number) => update({ action: "wait", ms: ms ?? DEFAULT_WAIT_MS }, true))
  method(handle, "kill", () => update({ action: "kill" }, true))
  method(handle, "refresh", () => update({ action: "check" }, true))
  return handle
}

/** The most output a handle holds, in characters: what one cell can show. Older output stays readable by offset. */
export const MAX_HANDLE_OUTPUT_CHARS = 64 * 1024

const encoder = new TextEncoder()
const byteLength = (text: string) => encoder.encode(text).length

/** `output` cut to its newest `MAX_HANDLE_OUTPUT_CHARS`, and whether earlier output is missing from it. */
const kept = (output: string, truncated: boolean) =>
  output.length > MAX_HANDLE_OUTPUT_CHARS
    ? { output: output.slice(-MAX_HANDLE_OUTPUT_CHARS), truncated: true }
    : { output, truncated }

/** The method a cell uses in place of each action that acts on a shell. */
const ACTIONS: Readonly<Record<string, (id: string) => string>> = {
  list: () => "await tools.shell.list()",
  kill: (id) => `(await tools.shell.handle(${id})).kill()`,
  wait: (id) => `(await tools.shell.handle(${id})).wait(ms)`,
  check: (id) => `(await tools.shell.handle(${id})).refresh()`,
}

/** The method a cell uses in place of each field that acts on a shell, the flags before actions among them. */
const INSTEAD: ReadonlyArray<readonly [field: string, method: (id: string) => string]> = [
  ["list", () => "await tools.shell.list()"],
  ["kill", (id) => `(await tools.shell.handle(${id})).kill()`],
  ["wait", (id) => `(await tools.shell.handle(${id})).wait(ms)`],
  ["ms", (id) => `(await tools.shell.handle(${id})).wait(ms)`],
  ["offset", (id) => `(await tools.shell.handle(${id})).read({ offset })`],
  ["lines", (id) => `(await tools.shell.handle(${id})).read({ lines })`],
  ["id", (id) => `(await tools.shell.handle(${id})).refresh()`],
]

/**
 * `tools.shell(input)`: runs a command and resolves to its live handle. An
 * input with an action other than `run` (`check`, `wait`, `kill`, `list`),
 * or a field that acts on a shell (`id`, `ms`, `offset`, `lines`, and the
 * older flags `kill`, `wait`, `list`), throws, naming the method to use instead.
 */
export const runShell = async (input: unknown, call: CallShell): Promise<ShellHandle> => {
  if (record(input)) {
    const id = typeof input.id === "string" ? JSON.stringify(input.id) : "id"
    const action = typeof input.action === "string" ? ACTIONS[input.action] : undefined
    if (action !== undefined)
      throw new TypeError(`tools.shell takes a command to run, not action "${String(input.action)}"; use ${action(id)}`)
    const found = INSTEAD.find(([field]) => input[field] !== undefined)
    if (found !== undefined) {
      const [field, instead] = found
      throw new TypeError(`tools.shell takes a command to run, not ${field}; use ${instead(id)}`)
    }
  }
  const result = await call(input)
  if (!isShellHandle(result)) throw new Error("The shell tool did not return a handle")
  return makeShellHandle(result, call)
}

/** `tools.shell.handle(id)`: a live handle for one of the session's shells, rebuilt by checking it. */
export const handleOf = async (id: unknown, call: CallShell): Promise<ShellHandle> => {
  if (typeof id !== "string" || !id.startsWith("sh_")) throw new TypeError("tools.shell.handle takes a shell ID (sh_…)")
  const result = await call({ action: "check", id })
  if (!isShellHandle(result)) throw new Error(`The shell tool did not return a handle for ${id}`)
  return makeShellHandle(result, call)
}

/**
 * `tools.shell.list()`: a live handle for each of the session's shells, from
 * one list call. A list shows no output, so each handle's `output` is empty
 * and its `next` is the output's size; the shell's read position stays where
 * it was, so `.refresh()` shows what is new since the last look.
 */
export const listShells = async (call: CallShell): Promise<ReadonlyArray<ListedShellHandle>> => {
  const result = await call({ action: "list" })
  const shells = record(result) ? result.shells : undefined
  if (!Array.isArray(shells)) throw new Error("The shell tool did not return a list of shells")
  return shells.map((entry: unknown) => {
    if (!isShellState(entry)) throw new Error("The shell tool listed a shell without its state")
    const { size, ...listed } = entry as ShellState & Omit<ListedShellHandle, keyof ShellHandle> & { readonly size: number }
    return makeShellHandle({ ...listed, output: "", next: size, truncated: false }, call)
  })
}
