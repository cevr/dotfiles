// The mail listener runs from the service's start: `opencode service start`,
// through the launcher daily writes (scripts/daily.ts `launcher`), loads the
// resident location, so a fresh server, with no client, no session and no
// turn, takes a signed delivery from a paired host. The fork runs from source
// in a scratch HOME with the mail plugin listening on a loopback port; the
// pairing is written as the pair command leaves it, and the peer's request is
// signed with the shared secret.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sign } from "../mods/mail/pairing.ts"
import { ROUTES } from "../mods/mail/peer.ts"
import { keyed, token } from "../mods/mail/node/keyed.ts"
import { launcher, residentConfig, residentDir } from "../scripts/daily.ts"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { freePort } from "./service.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/mail-start.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const ROOT = join(import.meta.dir, "..")
const TIMEOUT_MS = 120_000

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

const until = async <A>(read: () => A, done: (value: A) => boolean, label: () => string, ms = 60_000): Promise<A> => {
  const deadline = Date.now() + ms
  let last = read()
  while (!done(last)) {
    if (Date.now() > deadline) return expect.unreachable(`${label()}: still ${JSON.stringify(last)}`)
    await Bun.sleep(250)
    last = read()
  }
  return last
}

describe.skipIf(!fork)("the mail listener from the service's start", () => {
  const root = mkdtempSync(join(tmpdir(), "mail-start-"))
  const home = join(root, "home")
  const work = join(root, "work")
  const link = join(root, "bin/opencode")
  const launch = forkLaunch(fork ?? "", process.execPath)
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_DB: join(root, "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    ...launch.env,
  }
  // Not `owned`: the service `service start` leaves running is the point; `service stop` ends it, and
  // accept's leak check stops it if that fails.
  const opencode = async (...args: ReadonlyArray<string>) => {
    const child = Bun.spawn([link, ...args], { cwd: work, env, stdout: "pipe", stderr: "pipe" })
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, out, err }
  }
  afterAll(async () => {
    await opencode("service", "stop")
    rmSync(root, { recursive: true, force: true })
  })

  test(
    "a fresh service, with no client, session or turn, accepts a signed delivery from a paired host",
    async () => {
      for (const dir of [work, join(root, "bin"), join(home, ".config/opencode"), join(home, ".local/state/opencode-mail"), residentDir(home)]) mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(home, ".config/opencode/opencode.json"),
        JSON.stringify({ plugins: [{ package: join(ROOT, "cmd/mail"), options: { listen: { hostname: "127.0.0.1", port: 0 } } }] }),
      )
      writeFileSync(join(residentDir(home), "opencode.json"), JSON.stringify(residentConfig))
      // The fork from source stands in for the release binary the launcher runs.
      const binary = join(root, "bin/opencode-fork")
      writeFileSync(binary, `#!/bin/sh\nexec ${launch.base.map((word) => `'${word}'`).join(" ")} "$@"\n`)
      chmodSync(binary, 0o755)
      writeFileSync(link, launcher(binary, residentDir(home)), { mode: 0o755 })
      const secret = token(32)
      const pairs = join(home, ".local/state/opencode-mail/pairs.json")
      writeFileSync(pairs, JSON.stringify({ name: "workbox", peers: { mac: { url: "http://127.0.0.1:9", secret, paired: Date.now() } }, invites: [] }), { mode: 0o600 })

      // A port of its own: the other test files' scratch services would share the channel's fixed one (tests/service.ts).
      expect(await opencode("service", "set", "port", String(freePort()))).toMatchObject({ code: 0 })
      const started = await opencode("service", "start")
      expect([started.code, started.err]).toEqual([0, ""])

      // Nothing else asks the service anything.
      const url = await until(
        () => (readJson(pairs) as { url?: string } | undefined)?.url,
        (value) => typeof value === "string",
        () => "the mail listener",
      )
      const body = JSON.stringify({ to: "ses_nobody", from: { id: "ses_mac", title: "Mac main" }, replyTo: { id: "ses_mac", title: "Mac main" }, body: "hello", wake: false })
      const headers = sign("mac", secret, { method: "POST", path: ROUTES.receive, body }, Date.now(), token(16), keyed)
      const response = await fetch(new URL(ROUTES.receive, url ?? ""), { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
      // Authenticated and handled: a session this server lacks is `unknown`, not a refusal.
      expect([response.status, await response.json()]).toEqual([200, { outcome: "unknown" }])
    },
    TIMEOUT_MS,
  )
})
