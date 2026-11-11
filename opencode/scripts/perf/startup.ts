// How long a TUI takes to show a session, cold: starts a server and a TUI of an
// OpenCode checkout from source (its own XDG dirs, a database of your choosing,
// no provider credentials), opens the TUI on `--session` in a terminal of its
// own (zigpty, read through @xterm/headless) and writes, under `--out`:
// `timeline.jsonl` (each screen change: ms since the TUI started, the TUI's CPU
// seconds, the first lines), `frame-<ms>.txt` for the first frame that shows the
// session and the last, and `result.json` (ms to the first frame without the
// startup loader that shows the transcript, CPU at that point, RSS; the first
// frame of any kind, which ends the TUI's own boot; and `interactive`, when
// keys typed at the transcript's first frame echo in the composer).
// `--prof 5000,15000` sends the TUI SIGPROF at those ms: the fork writes a 10 s
// JS CPU profile into its log dir, which is copied to `--out`.
//
// bun scripts/perf/startup.ts (--fork <checkout> | --bin <compiled opencode>) --db <file> --session <id> --out <dir>
//   [--plugins <comma list of TUI plugin paths>] [--ready <text the session shows>] [--limit 180000]
//   [--cols 160] [--rows 45] [--prof <ms,...>] [--cli <json merged into cli.json>] [--hold <ms past ready>]
// `end` is the TUI's CPU and RSS when the run stops, `peakRss` the most it held.
//
// The server and TUI run in process groups of their own, killed at the end.
// Point `--db` only at a copy: the server writes to it.
import { Terminal } from "@xterm/headless"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { spawn as spawnPty } from "zigpty"

const args = process.argv.slice(2)
const opt = (name: string, fallback?: string) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const fork = opt("fork")
const bin = opt("bin")
const db = opt("db")!
const session = opt("session")!
const out = opt("out")!
const plugins = (opt("plugins") ?? "").split(",").filter(Boolean)
const readyText = opt("ready")
const limit = Number(opt("limit", "180000"))
const cols = Number(opt("cols", "160"))
const rows = Number(opt("rows", "45"))
const profAt = (opt("prof") ?? "").split(",").filter(Boolean).map(Number)
// `--hold 30000`: stay that long past ready, for the work a session starts in the background.
const hold = Number(opt("hold", "0"))
if ((!fork && !bin) || !db || !session || !out)
  throw new Error("usage: (--fork <checkout> | --bin <compiled opencode>) --db <file> --session <id> --out <dir>")

const xdg = join(out, "xdg")
for (const dir of ["data", "config/opencode", "state", "cache"]) mkdirSync(join(xdg, dir), { recursive: true })
// `--cli '{"session":{"sidebar":"hide"}}'`: more of the TUI config, as the owner's has it.
const cli = JSON.parse(opt("cli", "{}")!) as Record<string, unknown>
writeFileSync(join(xdg, "config/opencode/cli.json"), JSON.stringify({ ...cli, plugins, autoupdate: false }, null, 2))
writeFileSync(join(xdg, "config/opencode/opencode.json"), JSON.stringify({ autoupdate: false }, null, 2))

const port = await new Promise<number>((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const address = probe.address()
    probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
  })
})
const env: Record<string, string> = {
  HOME: process.env.HOME ?? "/tmp",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
  XDG_DATA_HOME: join(xdg, "data"),
  XDG_CONFIG_HOME: join(xdg, "config"),
  XDG_STATE_HOME: join(xdg, "state"),
  XDG_CACHE_HOME: join(xdg, "cache"),
  OPENCODE_DB: db,
  // The server asks for a password; this run's own.
  OPENCODE_PASSWORD: crypto.randomUUID(),
  // `OPENCODE_LOG_LEVEL=DEBUG` adds the TUI's plugin trace spans to its log.
  ...(process.env.OPENCODE_LOG_LEVEL ? { OPENCODE_LOG_LEVEL: process.env.OPENCODE_LOG_LEVEL } : {}),
}
const entry = bin
  ? [bin]
  : [
      "bun",
      "--conditions=browser",
      `--preload=${join(fork!, "packages/tui/node_modules/@opentui/solid/scripts/preload.js")}`,
      join(fork!, "packages/cli/src/index.ts"),
    ]

const server = Bun.spawn([...entry, "serve", "--port", String(port)], {
  env,
  cwd: out,
  stdout: Bun.file(join(out, "server.out.log")),
  stderr: Bun.file(join(out, "server.err.log")),
  detached: true,
})
const stopAll: Array<() => void> = [() => killGroup(server.pid)]
process.on("exit", () => stopAll.forEach((stop) => stop()))
function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGTERM")
  } catch {}
}

const serverReady = Date.now()
for (;;) {
  const ok = await fetch(`http://127.0.0.1:${port}/`).then(
    () => true,
    () => false,
  )
  if (ok) break
  if (Date.now() - serverReady > 120_000) throw new Error("the server did not listen in 120 s")
  await Bun.sleep(200)
}
console.log(`server up in ${Date.now() - serverReady} ms on ${port}`)

const terminal = new Terminal({ cols, rows, allowProposedApi: true })
const started = Date.now()
const tui = spawnPty(entry[0]!, [...entry.slice(1), "-s", session, "--server", `http://127.0.0.1:${port}`], {
  cols,
  rows,
  cwd: out,
  env,
  terminal: {
    data(_term, data: Uint8Array) {
      terminal.write(data)
    },
  },
})
stopAll.push(() => {
  try {
    process.kill(-tui.pid, "SIGTERM")
  } catch {}
  try {
    process.kill(tui.pid, "SIGTERM")
  } catch {}
})

const screen = () => {
  const buffer = terminal.buffer.active
  const lines: Array<string> = []
  for (let y = 0; y < rows; y++) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "")
  return lines
}
const cpu = (pid: number) => {
  const stat = `/proc/${pid}/stat`
  if (!existsSync(stat)) return { cpu: 0, rss: 0 }
  const fields = readFileSync(stat, "utf8").split(") ")[1]!.split(" ")
  return { cpu: (Number(fields[11]) + Number(fields[12])) / 100, rss: Math.round((Number(fields[21]) * 4096) / 1e6) }
}
/** The pid of the TUI's bun: the pty's child, or the pty's process itself. */
const tuiPid = tui.pid

const loader = /Loading plugins…|Finishing startup…/
const shown = (lines: ReadonlyArray<string>) => {
  const text = lines.join("\n")
  if (loader.test(text)) return false
  if (readyText) return text.includes(readyText)
  // The composer and some transcript above it.
  return lines.filter((line) => line.trim().length > 0).length > 8
}

const timeline: Array<string> = []
let last = ""
let first: { ms: number; cpu: number; rss: number } | undefined
let transcript: { ms: number; cpu: number; rss: number } | undefined
let ready: { ms: number; cpu: number; rss: number } | undefined
// Typed into the composer once the transcript shows; interactive is when it echoes.
const typed = "zqxj"
let key: { sent: number; echoed?: number } | undefined
const profiles = [...profAt]
let peakRss = 0
while (Date.now() - started < limit) {
  await Bun.sleep(50)
  const ms = Date.now() - started
  while (profiles.length > 0 && ms >= profiles[0]!) {
    profiles.shift()
    try {
      process.kill(tuiPid, "SIGPROF")
    } catch {}
  }
  const lines = screen()
  const text = lines.join("\n")
  if (text !== last) {
    last = text
    const usage = cpu(tuiPid)
    timeline.push(JSON.stringify({ ms, ...usage, head: lines.filter((line) => line.trim()).slice(0, 3).map((line) => line.trim().slice(0, 100)) }))
    // The TUI's own boot ends with its first drawn frame (the loader, home or the session).
    if (!first && lines.some((line) => line.trim().length > 0)) first = { ms, ...usage }
    // The first frame past the loader that shows a transcript, before `--ready`'s text settles in.
    if (!transcript && !loader.test(text) && lines.filter((line) => line.trim().length > 0).length > 8) {
      transcript = { ms, ...usage }
      writeFileSync(join(out, "frame-transcript.txt"), text)
    }
    if (!ready && shown(lines)) {
      ready = { ms, ...usage }
      writeFileSync(join(out, `frame-ready.txt`), text)
      console.log(`ready at ${ms} ms, cpu ${usage.cpu} s, rss ${usage.rss} MB`)
      tui.write(typed)
      key = { sent: ms }
    }
    if (key && key.echoed === undefined && text.includes(typed)) {
      key.echoed = ms
      console.log(`key echoed at ${ms} ms`)
    }
  }
  peakRss = Math.max(peakRss, cpu(tuiPid).rss)
  if (ready && profiles.length === 0 && ms - ready.ms > Math.max(3000, hold) && key?.echoed !== undefined) break
  if (ready && ms - ready.ms > Math.max(30_000, hold)) break
  if (!existsSync(`/proc/${tuiPid}`) && process.platform === "linux") break
}
const end = { ms: Date.now() - started, ...cpu(tuiPid) }
writeFileSync(join(out, "frame-last.txt"), last)
writeFileSync(join(out, "timeline.jsonl"), timeline.join("\n") + "\n")
// The fork's profiles run 10 s from each signal.
if (profAt.length > 0) await Bun.sleep(Math.max(0, profAt.at(-1)! + 11_000 - (Date.now() - started)))
const log = join(xdg, "data/opencode/log")
if (existsSync(log))
  for (const file of readdirSync(log).filter((name) => name.startsWith(`cpu-`))) copyFileSync(join(log, file), join(out, file))
const result = {
  session,
  plugins: plugins.length,
  first,
  transcript,
  ready,
  // From the first frame to the transcript: the session's own open, apart from the TUI's boot.
  open: first && ready ? ready.ms - first.ms : undefined,
  interactive: key?.echoed,
  end,
  peakRss,
  cols,
  rows,
}
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
stopAll.forEach((stop) => stop())
process.exit(0)
