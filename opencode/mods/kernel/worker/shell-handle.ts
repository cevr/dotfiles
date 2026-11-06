/**
 * The shell inside a cell: `await tools.shell({ command })` runs a command and
 * resolves to a live handle, and the handle's methods act on it. The shell
 * tool's JSON forms that act on a shell (`{ id }`, `{ id, wait }`,
 * `{ id, kill: true }`, `{ list: true }`) stay the model's direct tool input;
 * in a cell they are methods: `.refresh()`, `.wait(ms)`, `.kill()`,
 * `tools.shell.list()`, `tools.shell.handle(id)`.
 *
 * A handle is the shell tool's handle (`{ id, state, exitCode?, signal?,
 * runtimeMs, output, next, truncated, backgrounded? }`) as a live object. Its
 * data fields are plain and enumerable, so it prints, serializes and survives
 * a kernel restart as data; its methods are not enumerable, so a restart drops
 * them, and `tools.shell.handle(id)` builds a live one again.
 *
 * Each method calls the shell tool with the handle's id, writes the handle it
 * returns into this one, and resolves to this one. `output` is what the latest
 * call showed: the output since the look before it, or what `read` asked for.
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
  /** The output from byte `offset` (a handle's `next`), or the last `lines` lines; else what is new. */
  read(options?: { readonly offset?: number; readonly lines?: number }): Promise<ShellHandle>
  /** Waits up to `ms` for the command to end. */
  wait(ms?: number): Promise<ShellHandle>
  /** Stops the command: SIGTERM to its process group, SIGKILL 3 s later. No end notice follows. */
  kill(): Promise<ShellHandle>
  /** Its state now, and the output since the last look. */
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
  const update = async (input: Record<string, Json>): Promise<ShellHandle> => {
    const result = await call({ id: handle.id, ...input })
    if (!isShellHandle(result)) throw new Error(`The shell tool did not return a handle for ${handle.id}`)
    Object.assign(handle, result)
    return handle
  }
  method(handle, "read", (options?: { readonly offset?: number; readonly lines?: number }) =>
    update({
      ...(options?.offset === undefined ? {} : { offset: options.offset }),
      ...(options?.lines === undefined ? {} : { lines: options.lines }),
    }),
  )
  method(handle, "wait", (ms?: number) => update({ wait: ms ?? DEFAULT_WAIT_MS }))
  method(handle, "kill", () => update({ kill: true }))
  method(handle, "refresh", () => update({}))
  return handle
}

/** The method a cell uses in place of each field that acts on a shell. */
const INSTEAD: ReadonlyArray<readonly [field: string, method: (id: string) => string]> = [
  ["list", () => "await tools.shell.list()"],
  ["kill", (id) => `(await tools.shell.handle(${id})).kill()`],
  ["wait", (id) => `(await tools.shell.handle(${id})).wait(ms)`],
  ["offset", (id) => `(await tools.shell.handle(${id})).read({ offset })`],
  ["lines", (id) => `(await tools.shell.handle(${id})).read({ lines })`],
  ["id", (id) => `(await tools.shell.handle(${id})).refresh()`],
]

/**
 * `tools.shell(input)`: runs a command and resolves to its live handle. An
 * input with a field that acts on a shell (`id`, `kill`, `wait`, `offset`,
 * `lines`, `list`) throws, naming the method to use instead.
 */
export const runShell = async (input: unknown, call: CallShell): Promise<ShellHandle> => {
  if (record(input)) {
    const id = typeof input.id === "string" ? JSON.stringify(input.id) : "id"
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
  const result = await call({ id })
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
  const result = await call({ list: true })
  const shells = record(result) ? result.shells : undefined
  if (!Array.isArray(shells)) throw new Error("The shell tool did not return a list of shells")
  return shells.map((entry: unknown) => {
    if (!isShellState(entry)) throw new Error("The shell tool listed a shell without its state")
    const { size, ...listed } = entry as ShellState & Omit<ListedShellHandle, keyof ShellHandle> & { readonly size: number }
    return makeShellHandle({ ...listed, output: "", next: size, truncated: false }, call)
  })
}
