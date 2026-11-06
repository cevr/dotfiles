/**
 * The handle `await tools.shell({ command })` resolves to inside a cell: the
 * shell tool's handle (`{ id, state, exitCode?, signal?, runtimeMs, output,
 * next, truncated, backgrounded? }`) as a live object. Its data fields are
 * plain and enumerable, so it prints, serializes and survives a kernel restart
 * as data; its methods are not enumerable, so a restart drops them, and
 * `tools.shell.handle(id)` builds a live one again.
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

/** The shell tool's handle, as JSON. */
export interface ShellHandleData {
  readonly id: string
  readonly state: "running" | "exited" | "killed"
  readonly exitCode?: number
  readonly signal?: string
  readonly timedOut?: boolean
  readonly runtimeMs: number
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

/** Calls the shell tool with an input and resolves to its result. */
export type CallShell = (input: Json) => Promise<Json>

/** Whether a shell result is a handle (a `{ list: true }` call returns `{ shells }` instead). */
export const isShellHandle = (value: unknown): value is ShellHandleData =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof Reflect.get(value, "id") === "string" &&
  String(Reflect.get(value, "id")).startsWith("sh_") &&
  typeof Reflect.get(value, "state") === "string" &&
  typeof Reflect.get(value, "output") === "string"

const method = (handle: object, name: string, value: (...args: never[]) => unknown) =>
  Object.defineProperty(handle, name, { value, writable: true, enumerable: false, configurable: true })

/** `data` as a live handle whose methods reach the shell tool through `call`. */
export const makeShellHandle = (data: ShellHandleData, call: CallShell): ShellHandle => {
  const handle = { ...data } as ShellHandle
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

/** A shell result as a cell gets it: a handle made live, anything else as it came. */
export const shellValue = (value: Json, call: CallShell): unknown => (isShellHandle(value) ? makeShellHandle(value, call) : value)

/** `tools.shell.handle(id)`: a live handle for one of the session's shells, rebuilt by checking it. */
export const handleOf = async (id: unknown, call: CallShell): Promise<ShellHandle> => {
  if (typeof id !== "string" || !id.startsWith("sh_")) throw new TypeError("tools.shell.handle takes a shell ID (sh_…)")
  const result = await call({ id })
  if (!isShellHandle(result)) throw new Error(`The shell tool did not return a handle for ${id}`)
  return makeShellHandle(result, call)
}
