/**
 * Keep one program on a live pty for other processes:
 * `bun testbeds/gamut/pty-host.ts <config.json>`.
 *
 * The config (`HostConfig`) names the program, its directory, its whole
 * environment, the size and the Unix socket to listen on. The host reads it,
 * removes it (it may hold proxy values), starts the program and answers
 * requests on the socket until a `down` request. A program that exits by
 * itself leaves its last screen to read. `hostCall` is the client: gamut's
 * `send`, `keys`, `read`, `wait`, `restart` and `down` go through it.
 *
 * Ported from gent's `packages/e2e/src/pty-host.ts` as plain Bun: one JSON
 * request per connection, one JSON reply, then the connection closes.
 *
 * @module
 */
import { rmSync } from "node:fs"
import { Terminal } from "@xterm/headless"
import { spawn, type IPty } from "zigpty"

// ── Keys ──

/** The bytes a terminal in its default modes sends for each key a driver presses. */
export const keys = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  backspace: "\x7f",
  space: " ",
  "alt+up": "\x1b[1;3A",
  "alt+backspace": "\x1b\x7f",
  "ctrl+a": "\x01",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+e": "\x05",
  "ctrl+g": "\x07",
  "ctrl+j": "\n",
  "ctrl+k": "\x0b",
  "ctrl+l": "\x0c",
  "ctrl+n": "\x0e",
  "ctrl+o": "\x0f",
  "ctrl+p": "\x10",
  "ctrl+r": "\x12",
  "ctrl+s": "\x13",
  "ctrl+t": "\x14",
  "ctrl+u": "\x15",
  "ctrl+w": "\x17",
  "ctrl+x": "\x18",
  "ctrl+\\": "\x1c",
  "shift+enter": "\x1b[13;2u",
} as const satisfies Record<string, string>

export type KeyName = keyof typeof keys

export const isKeyName = (name: string): name is KeyName => Object.hasOwn(keys, name)

// ── Wire ──

export interface HostConfig {
  readonly socket: string
  readonly cwd: string
  readonly command: readonly [string, ...string[]]
  readonly env: Readonly<Record<string, string>>
  readonly cols: number
  readonly rows: number
}

/**
 * `read` scopes. `changes`: the rows added since the last `changes` or `full`
 * read, from the scrollback and the screen; the first read has every row.
 * `full`: the screen. Both move the mark. `screen`: the screen, the mark left
 * alone.
 */
export type ReadScope = "changes" | "full" | "screen"

export type HostRequest =
  | { readonly op: "type"; readonly text: string }
  | { readonly op: "keys"; readonly names: ReadonlyArray<string> }
  | { readonly op: "read"; readonly scope: ReadScope }
  | { readonly op: "restart"; readonly command: readonly [string, ...string[]] }
  | { readonly op: "down" }

/** What a read saw: the rows, and the exit code once the program has exited. */
export interface HostScreen {
  readonly rows: ReadonlyArray<string>
  /** How many rows of the last read are no longer on the screen or in the scrollback. */
  readonly gone: number
  readonly exited?: number
}

export interface HostReplies {
  readonly type: null
  readonly keys: null
  readonly read: HostScreen
  readonly restart: null
  readonly down: { readonly killed: boolean }
}

export type HostErrorTag = "UnknownKey" | "ProgramExited" | "QuitTimeout" | "BadRequest" | "HostGone"

/** A refused request, or a host that cannot be reached (`HostGone`). */
export class HostError extends Error {
  constructor(
    readonly tag: HostErrorTag,
    message: string,
  ) {
    super(message)
  }
}

type Reply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly tag: HostErrorTag; readonly message: string }

// ── Rows since the last read ──

/**
 * The rows of `after` that `before` does not hold in the same order (a
 * longest common subsequence), and how many rows of `before` are gone. A row
 * that moved, as the live area does when the scrollback grows, is not new.
 * Past `LCS_CELLS` the whole middle counts as changed.
 */
export interface RowsSince {
  readonly added: ReadonlyArray<string>
  readonly gone: number
}

const LCS_CELLS = 4_000_000

export const rowsSince = (before: ReadonlyArray<string>, after: ReadonlyArray<string>): RowsSince => {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  const old = before.slice(start, endBefore)
  const next = after.slice(start, endAfter)
  if (old.length * next.length > LCS_CELLS) return { added: next, gone: old.length }
  // `common(i, j)`: the longest common subsequence of `old` from `i` and `next` from `j`.
  const width = next.length + 1
  const table = new Int32Array((old.length + 1) * width)
  const common = (i: number, j: number) => table[i * width + j] ?? 0
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      if (old[i] === next[j]) table[i * width + j] = common(i + 1, j + 1) + 1
      else table[i * width + j] = Math.max(common(i + 1, j), common(i, j + 1))
    }
  }
  const added: string[] = []
  let i = 0
  for (const [j, row] of next.entries()) {
    while (i < old.length && old[i] !== row && common(i + 1, j) >= common(i, j + 1)) i++
    if (i < old.length && old[i] === row) i++
    else added.push(row)
  }
  return { added, gone: old.length - common(0, 0) }
}

// ── Hosted terminal ──

/**
 * The colours the emulator reports: a dark terminal's, Tomorrow Night's ground
 * and text over xterm.js's Tango palette. `@xterm/headless` parses a colour
 * query and answers none, so without these the TUI would draw as on a terminal
 * that keeps its colours to itself.
 */
const PALETTE = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
] as const

/** OSC 10 to 19 (foreground, background, cursor, mouse, Tek, highlight) and the colour each reports. */
const SPECIAL_COLORS: ReadonlyArray<readonly [number, string]> = [
  [10, "#c5c8c6"],
  [11, "#1d1f21"],
  [12, "#c5c8c6"],
  [13, "#c5c8c6"],
  [14, "#1d1f21"],
  [15, "#c5c8c6"],
  [16, "#1d1f21"],
  [17, "#373b41"],
  [19, "#c5c8c6"],
]

/** `#1d1f21` as an xterm colour reply spells it: `rgb:1d1d/1f1f/2121`. */
const xtermColor = (hex: string): string => {
  const channel = (at: number) => hex.slice(at, at + 2).repeat(2)
  return `rgb:${channel(1)}/${channel(3)}/${channel(5)}`
}

/** Answer `OSC 4;<i>;?` and `OSC <n>;?` as a terminal does. A set (not a query) is left to the emulator. */
const answerColorQueries = (screen: Terminal, reply: (text: string) => void) => {
  screen.parser.registerOscHandler(4, (data) => {
    const fields = data.split(";")
    const answers: string[] = []
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const index = Number(fields[at])
      const hex = PALETTE[index]
      if (fields[at + 1] !== "?" || hex === undefined) return false
      answers.push(`\x1b]4;${index};${xtermColor(hex)}\x1b\\`)
    }
    reply(answers.join(""))
    return true
  })
  for (const [ident, hex] of SPECIAL_COLORS) {
    screen.parser.registerOscHandler(ident, (data) => {
      if (data !== "?") return false
      reply(`\x1b]${ident};${xtermColor(hex)}\x1b\\`)
      return true
    })
  }
}

const killQuietly = (pid: number, group: boolean) => {
  try {
    process.kill(group ? -pid : pid, "SIGKILL")
  } catch {
    // Already gone.
  }
}

const exitedWithin = (pty: IPty, ms: number): Promise<number | undefined> =>
  pty.exitCode !== null
    ? Promise.resolve(pty.exitCode)
    : Promise.race([pty.exited, Bun.sleep(ms).then(() => undefined)])

/** A program on a live pty with an emulator on the other side, as on a dark terminal. */
interface Program {
  readonly pty: IPty
  readonly write: (bytes: string) => void
  /** The rows of the screen as drawn now, or of the scrollback and the screen, trailing blanks trimmed. */
  readonly rows: (scope: "viewport" | "all") => Promise<string[]>
  /** Stop the program: ctrl+c, a short wait, then SIGKILL to its process group. */
  readonly close: () => Promise<void>
}

const startProgram = (config: HostConfig, command: readonly [string, ...string[]]): Program => {
  const screen = new Terminal({
    cols: config.cols,
    rows: config.rows,
    scrollback: 100_000,
    allowProposedApi: true,
  })
  const pty = spawn(command[0], command.slice(1), {
    name: "xterm-256color",
    cols: config.cols,
    rows: config.rows,
    cwd: config.cwd,
    env: { ...config.env },
  })
  const write = (bytes: string) => {
    if (pty.exitCode !== null) return
    try {
      pty.write(bytes)
    } catch {
      // The program exited between the check and the write.
    }
  }
  pty.onData((data) => screen.write(typeof data === "string" ? data : new Uint8Array(data)))
  // Answer the program's terminal queries (device attributes, cursor position) and colour queries.
  screen.onData(write)
  answerColorQueries(screen, write)
  const drained = () => new Promise<void>((resolve) => screen.write("", resolve))
  const rows = async (scope: "viewport" | "all") => {
    await drained()
    const buffer = screen.buffer.active
    const [from, to] = scope === "viewport" ? [buffer.viewportY, buffer.viewportY + screen.rows] : [0, buffer.length]
    const out: string[] = []
    for (let y = from; y < to; y++) {
      // Cut at the width: after a shrink a line keeps cells past the last column.
      out.push((buffer.getLine(y)?.translateToString(false, 0, screen.cols) ?? "").trimEnd())
    }
    return out
  }
  const close = async () => {
    write(keys["ctrl+c"])
    if ((await exitedWithin(pty, 1000)) === undefined) {
      killQuietly(pty.pid, true)
      killQuietly(pty.pid, false)
      await exitedWithin(pty, 2000)
    }
    // A descendant the child left in its group goes with it.
    killQuietly(pty.pid, true)
    try {
      pty.close()
    } catch {
      // Already closed.
    }
    screen.dispose()
  }
  return { pty, write, rows, close }
}

// ── Host ──

/** How long `restart` and `down` press ctrl+c, every `QUIT_EVERY`, for the program to exit. */
const QUIT_WITHIN_MS = 15_000
const QUIT_EVERY_MS = 300

const nonBlank = (rows: ReadonlyArray<string>) => rows.filter((row) => row.length > 0)

/** One connection: the request read so far, and the reply bytes not yet written. */
interface Connection {
  readonly decoder: TextDecoder
  buffer: string
  out: Uint8Array | undefined
}

export interface ServedHost {
  /** Settles once the host has stopped: after a `down`, or `stop`. */
  readonly stopped: Promise<void>
  /** Close the program and stop listening. */
  readonly stop: () => Promise<void>
}

/**
 * Keep `config.command` on a pty and answer requests on `config.socket` until
 * a `down` request. However the host ends (a `down`, a socket that will not
 * bind, `stop`), its program is closed with it.
 */
export const serve = (config: HostConfig): ServedHost => {
  let program = startProgram(config, config.command)
  let mark: ReadonlyArray<string> = []
  let ended = false
  // One restart or down at a time, each run to its end once begun: two
  // restarts would both quit the same program and each start one, and the
  // host would keep only the last.
  let lifecycle: Promise<unknown> = Promise.resolve()
  const serial = <A>(work: () => Promise<A>): Promise<A> => {
    const run = lifecycle.then(work, work)
    lifecycle = run.catch(() => undefined)
    return run
  }

  let resolveStopped!: () => void
  const stopped = new Promise<void>((resolve) => (resolveStopped = resolve))

  let listener: ReturnType<typeof Bun.listen> | undefined
  const finish = async () => {
    if (ended) return
    ended = true
    listener?.stop(true)
    await program.close()
    resolveStopped()
  }

  const writeLive = (bytes: string) => {
    if (program.pty.exitCode !== null) {
      throw new HostError("ProgramExited", `the program exited ${program.pty.exitCode}`)
    }
    program.write(bytes)
  }

  /** Press ctrl+c until the program exits. */
  const quit = async (current: Program) => {
    const deadline = Date.now() + QUIT_WITHIN_MS
    while (Date.now() < deadline) {
      current.write(keys["ctrl+c"])
      if ((await exitedWithin(current.pty, QUIT_EVERY_MS)) !== undefined) return true
    }
    return current.pty.exitCode !== null
  }

  const handle = async (request: HostRequest): Promise<unknown> => {
    if (ended) throw new HostError("HostGone", "the host is stopping")
    switch (request.op) {
      case "type":
        writeLive(request.text)
        return null
      case "keys": {
        // Every name is checked before the first key is written; each key is
        // a write of its own, so `esc` then `down` never reads as alt+down.
        const bytes = request.names.map((name) => {
          if (!isKeyName(name)) {
            throw new HostError("UnknownKey", `no key named ${name}; keys: ${Object.keys(keys).join(", ")}`)
          }
          return keys[name]
        })
        for (const key of bytes) {
          writeLive(key)
          await Bun.sleep(15)
        }
        return null
      }
      case "read": {
        const code = program.pty.exitCode
        const exit = code === null ? {} : { exited: code }
        if (request.scope === "screen") return { rows: await program.rows("viewport"), gone: 0, ...exit }
        const all = nonBlank(await program.rows("all"))
        const before = mark
        mark = all
        if (request.scope === "full") return { rows: await program.rows("viewport"), gone: 0, ...exit }
        const { added, gone } = rowsSince(before, all)
        return { rows: added, gone, ...exit }
      }
      case "restart":
        return serial(async () => {
          if (!(await quit(program))) {
            throw new HostError(
              "QuitTimeout",
              `the program has not exited ${QUIT_WITHIN_MS / 1000}s after ctrl+c; inspect it with read --full`,
            )
          }
          await program.close()
          program = startProgram(config, request.command)
          mark = []
          return null
        })
      case "down":
        return serial(async () => {
          const clean = await quit(program)
          // The reply leaves before the host stops.
          setTimeout(() => void finish(), 200)
          return { killed: !clean }
        })
    }
  }

  /**
   * Write the reply, then close. A socket takes what its buffer holds and
   * returns the byte count; the rest waits for `drain`, so a long screen is
   * never cut short.
   */
  const reply = (socket: Bun.Socket<Connection>, body: Reply) => {
    socket.data.out = new TextEncoder().encode(`${JSON.stringify(body)}\n`)
    flush(socket)
  }

  const flush = (socket: Bun.Socket<Connection>) => {
    const out = socket.data.out
    if (out === undefined) return
    const written = socket.write(out)
    const rest = written < 0 ? out : out.subarray(written)
    if (rest.length > 0) {
      socket.data.out = rest
      return
    }
    socket.data.out = undefined
    socket.end()
  }

  try {
    listener = Bun.listen<Connection>({
      unix: config.socket,
      socket: {
        open: (socket) => {
          socket.data = { decoder: new TextDecoder(), buffer: "", out: undefined }
        },
        drain: (socket) => flush(socket),
        data: (socket, chunk) => {
          socket.data.buffer += socket.data.decoder.decode(chunk, { stream: true })
          const newline = socket.data.buffer.indexOf("\n")
          if (newline === -1) return
          const line = socket.data.buffer.slice(0, newline)
          socket.data.buffer = ""
          let request: HostRequest
          try {
            request = JSON.parse(line) as HostRequest
          } catch {
            return reply(socket, { ok: false, tag: "BadRequest", message: "a request is one JSON line" })
          }
          handle(request).then(
            (value) => reply(socket, { ok: true, value }),
            (error: unknown) =>
              reply(
                socket,
                error instanceof HostError
                  ? { ok: false, tag: error.tag, message: error.message }
                  : { ok: false, tag: "BadRequest", message: String(error) },
              ),
          )
        },
      },
    })
  } catch (error) {
    // The socket will not bind: the program goes with the host.
    ended = true
    const closing = program.close()
    return {
      stopped: closing.then(() => Promise.reject(error)),
      stop: () => closing,
    }
  }

  return { stopped, stop: finish }
}

// ── Client ──

/** Send `request` to the host on `socket`. A host that is gone fails with `HostGone`. */
export const hostCall = async <Op extends HostRequest["op"]>(
  socket: string,
  request: Extract<HostRequest, { op: Op }>,
): Promise<HostReplies[Op]> => {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  // A failed connect rejects both `Bun.connect` and this; the first is the one reported.
  promise.catch(() => undefined)
  // A character can straddle two chunks: decode as one stream.
  const decoder = new TextDecoder()
  let text = ""
  try {
    await Bun.connect({
      unix: socket,
      socket: {
        open: (conn) => {
          conn.write(`${JSON.stringify(request)}\n`)
        },
        data: (_conn, chunk) => {
          text += decoder.decode(chunk, { stream: true })
        },
        close: () => resolve(text + decoder.decode()),
        error: (_conn, error) => reject(error),
        connectError: (_conn, error) => reject(error),
      },
    })
  } catch (error) {
    throw new HostError("HostGone", `no host on ${socket}: ${String(error)}`)
  }
  const line = await promise.catch((error: unknown) => {
    throw new HostError("HostGone", `the host on ${socket} dropped the call: ${String(error)}`)
  })
  if (line.trim() === "") throw new HostError("HostGone", `the host on ${socket} closed without a reply`)
  const body = JSON.parse(line) as Reply
  if (!body.ok) throw new HostError(body.tag, body.message)
  return body.value as HostReplies[Op]
}

// ── Entry ──

if (import.meta.main) {
  const file = Bun.argv[2]
  if (file === undefined) {
    console.error("usage: bun pty-host.ts <config.json>")
    process.exit(2)
  }
  const config = (await Bun.file(file).json()) as HostConfig
  rmSync(file, { force: true })
  rmSync(config.socket, { force: true })
  const host = serve(config)
  const shutdown = () => void host.stop()
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
  try {
    await host.stopped
  } finally {
    rmSync(config.socket, { force: true })
  }
  process.exit(0)
}
