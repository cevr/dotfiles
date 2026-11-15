// How long the TUI takes to switch session tabs on big sessions: starts a server and a TUI of an
// OpenCode checkout from source (its own XDG dirs, the database you name, which must be a copy: the
// server writes to it), with `--tabs` seeded as the window's open tabs, the TUI on the first. Once the
// TUI has drawn the first tab and held still, it presses the next-tab key (`alt+down`) `--switches`
// times, each once the screen held still `--quiet` ms, and times each press from the key to the first
// changed screen (`first`) and to the last change before the quiet (`settle`), with the TUI's CPU
// seconds over the switch. `--keys tab,shift+tab` times those keys in the composer the same way,
// after the switches. Writes `result.json` (and `frame-<n>.txt` of each settled switch) under `--out`.
//
// bun perf/tab-switch.ts --fork <checkout> --db <copy> --tabs <id,id,...> --out <dir>
//   [--plugins <comma list of TUI plugin paths>] [--cli <json merged into cli.json>] [--switches 8] [--quiet 1500] [--cols 160] [--rows 45]
//   [--prof <switch index>] (SIGPROF to the TUI as that switch's key goes: the fork's 10 s CPU profile,
//   copied to --out) [--server <url> --password <pw>] (a running server instead of one of its own)
//
// The server and TUI run in process groups of their own, ended when the run ends.
import { Terminal } from "@xterm/headless"
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { spawn as spawnPty } from "zigpty"

const args = process.argv.slice(2)
const opt = (name: string, fallback?: string) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const fork = opt("fork")
const db = opt("db")
const tabs = (opt("tabs") ?? "").split(",").filter(Boolean)
const out = opt("out")
if (!fork || !db || tabs.length < 2 || !out)
  throw new Error("usage: --fork <checkout> --db <copy> --tabs <id,id,...> --out <dir>")
const plugins = (opt("plugins") ?? "").split(",").filter(Boolean)
const switches = Number(opt("switches", "8"))
const quiet = Number(opt("quiet", "1500"))
const cols = Number(opt("cols", "160"))
const rows = Number(opt("rows", "45"))
const profAt = opt("prof") === undefined ? -1 : Number(opt("prof"))
const keys = (opt("keys") ?? "").split(",").filter(Boolean)
const outDir = resolve(out)

const xdg = join(outDir, "xdg")
for (const dir of ["data", "config/opencode", "state", "cache"]) mkdirSync(join(xdg, dir), { recursive: true })
// `--cli '{"animations":false}'`: more of the TUI's config.
const cliConfig = JSON.parse(opt("cli", "{}")!) as Record<string, unknown>
writeFileSync(
  join(xdg, "config/opencode/cli.json"),
  JSON.stringify({ ...cliConfig, plugins, autoupdate: false }, null, 2),
)
writeFileSync(join(xdg, "config/opencode/opencode.json"), JSON.stringify({ autoupdate: false }, null, 2))
// The default scope ("cwd"), as the workbox has it: every TUI there runs in the same folder.
const channel = "bench"
const tabsFile = join(xdg, "state/opencode", channel, "tui/tabs.json")
mkdirSync(join(tabsFile, ".."), { recursive: true })
const seeded = { tabs: tabs.map((sessionID) => ({ sessionID })), unread: {} }
writeFileSync(tabsFile, JSON.stringify({ global: seeded, cwd: { [outDir]: seeded } }, null, 2))

const port = await new Promise<number>((done) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const address = probe.address()
    probe.close(() => done(typeof address === "object" && address ? address.port : 0))
  })
})
const password = opt("password") ?? crypto.randomUUID()
const env: Record<string, string> = {
  HOME: process.env.HOME ?? "/tmp",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
  XDG_DATA_HOME: join(xdg, "data"),
  XDG_CONFIG_HOME: join(xdg, "config"),
  XDG_STATE_HOME: join(xdg, "state"),
  XDG_CACHE_HOME: join(xdg, "cache"),
  OPENCODE_DB: resolve(db),
  OPENCODE_PASSWORD: password,
  OPENCODE_TUI_CHANNEL: channel,
  // `--env KEY=VALUE,KEY=VALUE`: more of the TUI's and server's environment.
  ...Object.fromEntries(
    (opt("env") ?? "")
      .split(",")
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  ),
}
const entry = [
  "bun",
  "--conditions=browser",
  `--preload=${join(fork, "packages/tui/node_modules/@opentui/solid/scripts/preload.js")}`,
  join(fork, "packages/cli/src/index.ts"),
]
const stops: Array<() => void> = []
process.on("exit", () => stops.forEach((stop) => stop()))
const endGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGTERM")
  } catch {}
}

const serverUrl = opt("server") ?? `http://127.0.0.1:${port}`
if (!opt("server")) {
  const server = Bun.spawn([...entry, "serve", "--port", String(port)], {
    env,
    cwd: outDir,
    stdout: Bun.file(join(outDir, "server.out.log")),
    stderr: Bun.file(join(outDir, "server.err.log")),
    detached: true,
  })
  stops.push(() => endGroup(server.pid))
  const since = Date.now()
  for (;;) {
    const up = await fetch(serverUrl).then(
      () => true,
      () => false,
    )
    if (up) break
    if (Date.now() - since > 120_000) throw new Error("the server did not listen in 120 s")
    await Bun.sleep(200)
  }
  console.log(`server up in ${Date.now() - since} ms`)
}

const terminal = new Terminal({ cols, rows, allowProposedApi: true })
const tui = spawnPty(entry[0]!, [...entry.slice(1), "-s", tabs[0]!, "--server", serverUrl], {
  cols,
  rows,
  cwd: outDir,
  env,
  terminal: {
    data(_term, data: Uint8Array) {
      terminal.write(data)
      answerColors(new TextDecoder().decode(data))
    },
  },
})
terminal.onData((data) => tui.write(data))
let tuiExited = false
void tui.exited.then(() => (tuiExited = true))
const COLOR_QUERY = new RegExp(String.raw`\u001b\](1[01]);\?(\u0007|\u001b\\)`, "g")
function answerColors(text: string) {
  for (const match of text.matchAll(COLOR_QUERY))
    tui.write(`\x1b]${match[1]};rgb:${match[1] === "11" ? "1e1e/1e1e/1e1e" : "d4d4/d4d4/d4d4"}${match[2]}`)
}
stops.push(() => {
  endGroup(tui.pid)
  try {
    process.kill(tui.pid, "SIGTERM")
  } catch {}
})

const screen = () => {
  const buffer = terminal.buffer.active
  const lines: Array<string> = []
  for (let y = 0; y < rows; y++) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "")
  return lines.join("\n")
}
// Every parsed write that changed the screen, stamped.
let last = ""
let changedAt = performance.now()
let changes = 0
terminal.onWriteParsed(() => {
  const text = screen()
  if (text === last) return
  last = text
  changedAt = performance.now()
  changes++
})
/** The TUI's CPU seconds (user + system), from ps: the pty's child is the TUI's bun. */
const cpu = () => {
  const result = Bun.spawnSync(["ps", "-o", "time=", "-p", String(tui.pid)])
  const text = result.stdout.toString().trim()
  if (!text) return 0
  const parts = text.split(":").map(Number)
  return parts.reduce((total, part) => total * 60 + part, 0)
}
const stillFor = async (ms: number, limit: number) => {
  const since = performance.now()
  while (performance.now() - since < limit) {
    if (performance.now() - changedAt >= ms) return true
    await Bun.sleep(10)
  }
  return false
}

const started = performance.now()
// Ready: the transcript shows, past the loader.
const loader = /Loading plugins…|Finishing startup…/
for (;;) {
  const text = last
  if (!loader.test(text) && text.split("\n").filter((line) => line.trim()).length > 8) break
  if (performance.now() - started > 180_000) throw new Error("the TUI did not show the first tab in 180 s")
  if (tuiExited) throw new Error(`the TUI exited before it showed the first tab:\n${last}`)
  await Bun.sleep(50)
}
console.log(`first tab shown at ${Math.round(performance.now() - started)} ms`)
// The first tab's children, prefetch and plugin work all land in the first seconds; wait them out.
await stillFor(3000, 60_000)
await Bun.sleep(2000)
await stillFor(quiet, 30_000)
// What the TUI burns on its own with no input, for the switches' CPU to be read against.
const idleCpu = cpu()
await Bun.sleep(5000)
const idle = Math.round(((cpu() - idleCpu) / 5) * 1000)
console.log(`idle: ${idle} ms CPU per s`)

type Timed = { key: string; first?: number; settle: number; changes: number; cpu: number }
const press = async (key: string, bytes: string, prof: boolean): Promise<Timed> => {
  await stillFor(quiet, 30_000)
  const before = changes
  const cpuBefore = cpu()
  const sent = performance.now()
  let first: number | undefined
  const watch = terminal.onWriteParsed(() => {
    if (first === undefined && changes > before) first = performance.now() - sent
  })
  if (prof) process.kill(tui.pid, "SIGPROF")
  tui.write(bytes)
  // Wait for the first change (at most 10 s), then for the quiet.
  while (changes === before && performance.now() - sent < 10_000) await Bun.sleep(5)
  await stillFor(quiet, 30_000)
  watch.dispose()
  return {
    key,
    first: first === undefined ? undefined : Math.round(first),
    settle: Math.round(changes === before ? 0 : changedAt - sent),
    changes: changes - before,
    cpu: Math.round((cpu() - cpuBefore) * 1000),
  }
}
const KEYS: Record<string, string> = {
  "alt+down": "\x1b[1;3B",
  tab: "\t",
  "shift+tab": "\x1b[Z",
}
const results: Array<Timed> = []
for (let index = 0; index < switches; index++) {
  const result = await press("alt+down", KEYS["alt+down"]!, index === profAt)
  results.push(result)
  writeFileSync(join(outDir, `frame-${index}.txt`), last)
  console.log(JSON.stringify(result))
}
for (const key of keys) {
  const result = await press(key, KEYS[key] ?? key, false)
  results.push(result)
  writeFileSync(join(outDir, `frame-${key}.txt`), last)
  console.log(JSON.stringify(result))
}
if (profAt >= 0) {
  await Bun.sleep(11_000)
  const log = join(xdg, "data/opencode/log")
  if (existsSync(log))
    for (const file of readdirSync(log).filter((name) => name.startsWith("cpu-"))) copyFileSync(join(log, file), join(outDir, file))
}
const median = (values: Array<number>) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const switched = results.filter((result) => result.key === "alt+down")
const summary = {
  fork,
  tabs: tabs.length,
  plugins: plugins.length,
  switches: switched.length,
  idle,
  first: median(switched.flatMap((result) => (result.first === undefined ? [] : [result.first]))),
  settle: median(switched.map((result) => result.settle)),
  cpu: median(switched.map((result) => result.cpu)),
  results,
}
writeFileSync(join(outDir, "result.json"), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ ...summary, results: undefined }))
stops.forEach((stop) => stop())
process.exit(0)
