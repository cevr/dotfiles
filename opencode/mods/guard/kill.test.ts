// The kill rule on its own, over a process table like the workbox's: the
// OpenCode server, a TUI, a kernel worker, a runaway test and a dev server.
// Probe patterns name only harmless processes; nothing here sends a signal.
import { describe, expect, test } from "bun:test"
import { killFindings, killsByPattern, killVerdict, type ProcessInfo } from "./kill.ts"

const SERVER = 4100
const TABLE: ReadonlyArray<ProcessInfo> = [
  { pid: 1, name: "systemd", args: "/sbin/init" },
  { pid: SERVER, name: "opencode-2.2.5-p", args: "/home/me/.local/share/opencode-prime/opencode-2.2.5-prime.a3645815 serve --service" },
  { pid: 4200, name: "opencode-2.2.5-p", args: "/home/me/.local/share/opencode-prime/opencode-2.2.5-prime.a3645815 -s ses_abc" },
  { pid: 4300, name: "opencode-2.2.5-p", args: "/home/me/.local/share/opencode-prime/opencode-2.2.5-prime.a3645815 --config=/dev/null /home/me/dotfiles/opencode/mods/kernel/worker/program.ts" },
  { pid: 5000, name: "bun", args: "/home/me/.bun/bin/bun test client/src/runtime" },
  { pid: 5100, name: "vite", args: "node /work/app/node_modules/.bin/vite --port 5173" },
  { pid: 5200, name: "sleep", args: "sleep 600" },
]

const reasonOf = (command: string, table: ReadonlyArray<ProcessInfo> = TABLE) => {
  const answer = killVerdict(command, table, SERVER)
  return answer._tag === "Deny" ? answer.reason : undefined
}

describe("a kill by pattern that reaches OpenCode is refused, naming the process and the PID way", () => {
  test("pkill -f of a word in the server's command line", () => {
    expect(reasonOf("pkill -f opencode")).toBe(
      "`pkill -f opencode` would also kill the OpenCode server this session runs on, pid 4100 (`/home/me/.local/share/opencode-prime/opencode-2.2.5-prime.a3645815 serve --service`); find the PID you mean (`pgrep -fl <pattern>`, `ps`) and `kill <pid>`",
    )
    for (const command of ["pkill -f serve", "pkill -9 -f 'serve --service'", "pkill -f prime", "pkill -f -i OPENCODE", "pkill --full share/opencode", "pkill -f program.ts", "pkill -f .local"])
      expect([command, reasonOf(command)?.split(";")[0]]).toEqual([command, expect.stringContaining("would also kill") as unknown as string])
  })

  test("a TUI or a kernel worker is reached as well as the server", () => {
    expect(reasonOf("pkill -f 'ses_'")).toContain("an OpenCode process (a TUI or another server), pid 4200")
    expect(reasonOf("pkill -f kernel/worker")).toContain("pid 4300")
  })

  test("pkill and killall by name, the name read as the program's file name too", () => {
    expect(reasonOf("pkill opencode")).toContain("pid 4100")
    expect(reasonOf("killall opencode-2.2.5-prime.a3645815")).toContain("pid 4100")
    expect(reasonOf("killall -9 -r '^open'")).toContain("pid 4100")
    expect(reasonOf("sudo killall -m open.*")).toContain("pid 4100")
  })

  test("kill fed by pgrep or pidof, in a substitution, backquotes or a pipe", () => {
    expect(reasonOf("kill $(pgrep -f opencode)")).toContain("`pgrep -f opencode` would also kill the OpenCode server")
    expect(reasonOf("kill -9 `pgrep -f serve`")).toContain("pid 4100")
    expect(reasonOf("pgrep -f opencode | xargs kill")).toContain("pid 4100")
    expect(reasonOf("pgrep -f opencode | xargs -r kill -TERM")).toContain("pid 4100")
    expect(reasonOf("kill $(pidof opencode-2.2.5-prime.a3645815)")).toContain("pid 4100")
  })

  test("inside sh -c, eval and a chain", () => {
    expect(reasonOf("bash -c 'pkill -f opencode'")).toContain("pid 4100")
    expect(reasonOf("eval pkill -f opencode")).toContain("pid 4100")
    expect(reasonOf("cd /tmp && bun test; pkill -f serve || true")).toContain("pid 4100")
  })

  test("pkill with no pattern, by user alone, takes every process the user owns", () => {
    expect(reasonOf("pkill -u me")).toContain("pid 4100")
  })

  test("a pattern the reader cannot run is refused rather than guessed", () => {
    expect(reasonOf("pkill -f 'serve('")).toBe(
      "`pkill -f serve(` kills by a pattern the guard cannot read, so it may reach the OpenCode server; find the PID you mean (`pgrep -fl <pattern>`, `ps`) and `kill <pid>`",
    )
  })

  test("kill -1 signals every process the user owns, whatever runs", () => {
    expect(reasonOf("kill -1", [])).toBe(
      "`kill -1` signals every process you own, the OpenCode server among them; find the PID you mean (`pgrep -fl <pattern>`, `ps`) and `kill <pid>`",
    )
    for (const command of ["kill -9 -1", "kill -HUP -- -1", "kill -s TERM -1", "/bin/kill -KILL -1"]) expect([command, reasonOf(command, [])]).toEqual([command, expect.stringContaining("signals every process you own") as unknown as string])
  })
})

describe("a kill that cannot reach OpenCode runs", () => {
  test("a pattern that matches only the work's own processes", () => {
    for (const command of ["pkill -f vite", "pkill -f 'bun test'", "pkill sleep", "killall vite", "kill $(pgrep -f vite)", "pgrep -f 'bun test' | xargs kill", "pkill -f /nonexistent/loop-probe-x"])
      expect([command, reasonOf(command)]).toEqual([command, undefined])
  })

  test("pkill -x and killall match a name whole, not a part of it", () => {
    expect(reasonOf("pkill -x open")).toBeUndefined()
    expect(reasonOf("killall open")).toBeUndefined()
    // Without -f a pattern reads the name, not the command line.
    expect(reasonOf("pkill serve")).toBeUndefined()
  })

  test("a kill by PID, a signal-0 probe, a pgrep that only lists, and kills by parent or pidfile", () => {
    for (const command of [
      "kill 5000",
      "kill -9 5000 5100",
      "kill -1 5000",
      "pkill -0 -f opencode",
      "pkill --signal 0 -f opencode",
      "killall -0 opencode",
      "pgrep -fl opencode",
      "pgrep -f opencode && echo running",
      "pkill -P 5000",
      "pkill -F /tmp/vite.pid",
      "echo 'pkill -f opencode'",
      "git commit -m 'refuse pkill -f opencode'",
    ])
      expect([command, reasonOf(command)]).toEqual([command, undefined])
  })
})

describe("what the line asks of the process table", () => {
  test("only a kill by pattern reads it", () => {
    expect(killsByPattern("pkill -f vite")).toBe(true)
    expect(killsByPattern("kill $(pgrep vite)")).toBe(true)
    expect(killsByPattern("pgrep vite")).toBe(false)
    expect(killsByPattern("kill -1")).toBe(false)
    expect(killsByPattern("kill 5000")).toBe(false)
    expect(killsByPattern("bun test")).toBe(false)
  })

  test("pkill's options before the pattern, value options skipped", () => {
    expect(killFindings("pkill -u root -f vite")).toEqual([
      { _tag: "Pattern", target: { command: "pkill -u root -f vite", pattern: "vite", field: "full", exact: false, ignoreCase: false } },
    ])
    expect(killFindings("pkill -fu root vite")).toEqual([
      { _tag: "Pattern", target: { command: "pkill -fu root vite", pattern: "vite", field: "full", exact: false, ignoreCase: false } },
    ])
  })
})
