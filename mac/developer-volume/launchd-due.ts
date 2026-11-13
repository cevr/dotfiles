// Lists the launch agents that refer to ROOT (in their plist, or in a script their
// ProgramArguments name) and when each fires next. Read-only.
//
//   bun launchd-due.ts ROOT HOURS [AGENTS_DIR=~/Library/LaunchAgents] [NOW_EPOCH_S]
//
// Prints one line per agent: "<label>\t<loaded|unloaded>\t<due>\t<plist>", where <due>
// is "now" (it can fire any time: RunAtLoad with KeepAlive, StartInterval, WatchPaths,
// QueueDirectories), an ISO time within HOURS from now, or "later" (after HOURS).
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const [root, hoursArg, agentsArg, nowArg] = process.argv.slice(2)
if (root === undefined || hoursArg === undefined) {
  console.error("usage: bun launchd-due.ts ROOT HOURS [AGENTS_DIR] [NOW_EPOCH_S]")
  process.exit(2)
}
const agents = agentsArg || join(homedir(), "Library/LaunchAgents")
const now = !nowArg ? new Date() : new Date(Number(nowArg) * 1000)
const horizon = new Date(now.getTime() + Number(hoursArg) * 3600_000)

type Calendar = { Minute?: number; Hour?: number; Day?: number; Weekday?: number; Month?: number }
type Plist = {
  Label?: string
  ProgramArguments?: Array<string>
  Program?: string
  StartCalendarInterval?: Calendar | Array<Calendar>
  StartInterval?: number
  KeepAlive?: unknown
  WatchPaths?: Array<string>
  QueueDirectories?: Array<string>
}

const readText = (path: string): string => {
  try {
    return statSync(path).isFile() && statSync(path).size < 1_000_000 ? readFileSync(path, "utf8") : ""
  } catch {
    return ""
  }
}
const names = (text: string) => text.includes(`${root}/`) || text.includes(`${root}<`) || text.includes(`${root}"`)

const matches = (c: Calendar, t: Date): boolean =>
  (c.Minute === undefined || c.Minute === t.getMinutes()) &&
  (c.Hour === undefined || c.Hour === t.getHours()) &&
  (c.Day === undefined || c.Day === t.getDate()) &&
  (c.Month === undefined || c.Month === t.getMonth() + 1) &&
  (c.Weekday === undefined || c.Weekday % 7 === t.getDay())

// The first minute after now, up to the horizon, that a calendar entry matches.
const nextFire = (calendars: Array<Calendar>): Date | undefined => {
  const t = new Date(now.getTime())
  t.setSeconds(0, 0)
  for (t.setMinutes(t.getMinutes() + 1); t <= horizon; t.setMinutes(t.getMinutes() + 1)) {
    if (calendars.some((c) => matches(c, t))) return new Date(t.getTime())
  }
  return undefined
}

const loaded = (label: string): boolean => {
  const uid = process.getuid?.() ?? 0
  return Bun.spawnSync(["launchctl", "print", `gui/${uid}/${label}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
}

let files: Array<string> = []
try {
  files = readdirSync(agents).filter((name) => name.endsWith(".plist"))
} catch {}
for (const name of files.sort()) {
  const path = join(agents, name)
  const converted = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", path])
  if (converted.exitCode !== 0) continue
  let plist: Plist
  try {
    plist = JSON.parse(converted.stdout.toString()) as Plist
  } catch {
    continue
  }
  const args = [...(plist.ProgramArguments ?? []), ...(plist.Program === undefined ? [] : [plist.Program])]
  if (!names(readText(path)) && !args.some((arg) => arg.startsWith("/") && names(readText(arg)))) continue
  const label = plist.Label ?? name.replace(/\.plist$/, "")
  const anyTime =
    plist.StartInterval !== undefined || plist.WatchPaths !== undefined || plist.QueueDirectories !== undefined ||
    (plist.KeepAlive !== undefined && plist.KeepAlive !== false)
  const calendars = plist.StartCalendarInterval === undefined ? [] : [plist.StartCalendarInterval].flat()
  const next = calendars.length > 0 ? nextFire(calendars) : undefined
  const due = anyTime ? "now" : next !== undefined ? next.toISOString() : "later"
  console.log(`${label}\t${loaded(label) ? "loaded" : "unloaded"}\t${due}\t${path}`)
}
