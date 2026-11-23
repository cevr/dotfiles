// accept: deep (3.3 s alone on a quiet host: 1-minute load 3.8 on 12 cores; it starts a real Chrome for Testing twice and needs Playwright's Chrome installed)
// accept: one at a time (it binds loopback ports and starts real browsers)
// A real, isolated Chrome through scripts/chrome.ts only, so both keychain flags are always on its command line, with
// a scratch profile under a scratch run directory, never the owner's Chrome: on any free port (Chrome writes
// DevToolsActivePort) and on a fixed port (Chrome writes none) the launch prints the endpoint of its own browser,
// which answers there, and `stop` ends it; on a port another process holds the launch fails at once, naming it, and
// that process keeps serving. Every browser is stopped by the pid the launch printed.
import { afterAll, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { parentEnv, scratch } from "./scratch.ts"

const SCRIPT = join(import.meta.dir, "../scripts/chrome.ts")
const HOME = parentEnv.HOME ?? ""
const CACHE = parentEnv.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === "darwin" ? `${HOME}/Library/Caches/ms-playwright` : `${HOME}/.cache/ms-playwright`)
const installed = readdirSync(CACHE, { withFileTypes: true }).some((entry) => /^chromium[-_]/.test(entry.name))
if (!installed) console.warn(`tests/chrome-launch.test.ts: skipped. No Playwright Chrome in ${CACHE}.`)

/** Pids a launch printed and no stop has ended yet: stopped by `stop` after the file, whatever failed. */
const started = new Set<number>()

const cli = (args: ReadonlyArray<string>) => {
  const run = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env: { ...parentEnv, PLAYWRIGHT_BROWSERS_PATH: CACHE }, stdin: "ignore", timeout: 40_000 })
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}

const Launched = (stdout: string) => JSON.parse(stdout) as { endpoint: string; port: number; pid: number; folder: string; binary: string }

const stop = (pid: number) => {
  const ended = cli(["stop", String(pid)])
  if (ended.code === 0) started.delete(pid)
  return ended
}

afterAll(() => {
  for (const pid of started) stop(pid)
})

/** What the browser at `port` answers on `/json/version`, and the argv `ps` reads of `pid`. */
const check = async (port: number, pid: number) => {
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }
  const argv = Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)]).stdout.toString()
  return { url: version.webSocketDebuggerUrl, argv }
}

const freePort = async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
  const port = Number(server.port)
  await server.stop(true)
  return port
}

describe.skipIf(!installed)("a real Chrome through scripts/chrome.ts", () => {
  test("on any free port and on a fixed one, it prints its own browser's endpoint, keychain flags on, and stop ends it", async () => {
    using dir = scratch("chrome-launch-")
    for (const asked of [0, await freePort()]) {
      const launched = cli(["launch", "--dir", dir.path, "--port", String(asked), "--", "--disable-background-networking"])
      expect([asked, launched.code, launched.stderr]).toEqual([asked, 0, ""])
      const record = Launched(launched.stdout)
      started.add(record.pid)
      if (asked > 0) expect(record.port).toBe(asked)
      expect(record.folder.startsWith(`${dir.path}/chrome-`)).toBe(true)
      const seen = await check(record.port, record.pid)
      expect(seen.url).toBe(record.endpoint)
      expect(seen.argv).toContain(`--user-data-dir=${record.folder}/profile --remote-debugging-port=${asked} --use-mock-keychain --password-store=basic`)
      expect(stop(record.pid).code).toBe(0)
      expect(Bun.spawnSync(["ps", "-p", String(record.pid)]).exitCode).not.toBe(0)
    }
    expect(readdirSync(dir.path)).toEqual([])
  }, 90_000)

  test("on a port another process holds, it fails at once naming that process, starts no browser, and the holder keeps serving", async () => {
    using dir = scratch("chrome-held-")
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("holder") })
    try {
      const refused = cli(["launch", "--dir", dir.path, "--port", String(holder.port)])
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain(`port ${holder.port} is in use by pid ${process.pid}`)
      expect(readdirSync(dir.path)).toEqual([])
      expect(await (await fetch(`http://127.0.0.1:${holder.port}/`)).text()).toBe("holder")
    } finally {
      await holder.stop(true)
    }
  }, 30_000)
})
