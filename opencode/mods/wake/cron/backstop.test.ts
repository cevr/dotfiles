// @reads all
// @reads-reason computed read at mods/wake/cron/backstop.test.ts: const entry = readFileSync(file, "utf8")
// The Bun.cron backstop over a stand-in scheduler: an exec that does what
// Bun.cron does to a LaunchAgents directory (macOS) or a crontab (Linux), so
// the laws run without registering a real job. The job's entry file is run by
// a real bun against a stand-in script, to show it hands the descriptor over.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, type Scope } from "effect"
import { backstopLaws } from "../laws.ts"
import { bounded, type TestBounds, testLimitMs } from "../process/readiness.ts"
import { Backstop } from "../service.ts"
import { type Config, crontabTitles, type Exec, exec, layer, plistTitles, relinked, stableScript } from "./backstop.ts"

/** A scratch directory of the test's own, with an empty LaunchAgents directory, removed when its scope closes. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "wake-cron-"))
    mkdirSync(path.join(dir, "LaunchAgents"))
    return dir
  }),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/** A backstop test's bounds: a body of a few scheduler calls and one bun run, and a release that removes a directory. */
const BOUNDS: TestBounds = { body: "30 seconds", release: "1 second" }

/** The one Bun test of this file that runs an Effect: in a scratch directory of its own, bounded below its Bun limit, so its scope closes first. */
const scratchTest = <A, E>(name: string, body: (dir: string) => Effect.Effect<A, E, Scope.Scope>) =>
  test(name, () => Effect.runPromise(bounded(name, Effect.flatMap(scratch, body), BOUNDS)), testLimitMs(BOUNDS))

/** A scheduler that does what Bun.cron does, in `agents` (macOS) or in `crontab` (Linux). */
const scheduler = (platform: "darwin" | "linux", agents: string, crontab: { text: string }, calls: Array<ReadonlyArray<string>>): Exec => (argv) =>
  Effect.sync(() => {
    calls.push(argv)
    const [, flag, code, ...args] = argv
    if (argv[0] === "crontab") return { exitCode: crontab.text === "" ? 1 : 0, stdout: crontab.text, stderr: crontab.text === "" ? "crontab: no crontab for me" : "" }
    if (flag !== "-e") return { exitCode: 2, stdout: "", stderr: "unexpected" }
    if (code?.includes("Bun.cron.remove")) {
      const [title] = args
      if (platform === "darwin") rmSync(path.join(agents, `bun.cron.${title}.plist`), { force: true })
      else crontab.text = crontab.text.split("\n").filter((line) => !line.endsWith(`# bun-cron: ${title}`)).join("\n")
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    const [file, cron, title] = args
    if (platform === "darwin") writeFileSync(path.join(agents, `bun.cron.${title}.plist`), `<plist>${file} ${cron}</plist>`)
    else crontab.text = [...crontab.text.split("\n").filter((line) => line !== "" && !line.endsWith(`# bun-cron: ${title}`)), `${cron} bun run ${file} # bun-cron: ${title}`].join("\n")
    return { exitCode: 0, stdout: "", stderr: "" }
  })

const configOf = (platform: "darwin" | "linux", dir: string, crontab: { text: string }, calls: Array<ReadonlyArray<string>> = []): Config => ({
  bun: "/opt/bun/bin/bun",
  script: "/dotfiles/opencode/cmd/wake/backstop.ts",
  jobs: path.join(dir, "jobs"),
  opencode: "/home/me/.local/bin/opencode",
  env: { HOME: "/home/me", XDG_STATE_HOME: "/state", OPENCODE_CONFIG_DIR: "/config", SECRET_TOKEN: "no", PATH: "/usr/bin" },
  platform,
  launchAgents: path.join(dir, "LaunchAgents"),
  exec: scheduler(platform, path.join(dir, "LaunchAgents"), crontab, calls),
})

for (const platform of ["darwin", "linux"] as const)
  backstopLaws(
    `Bun.cron on ${platform}`,
    Effect.map(scratch, (dir) => {
      const agents = path.join(dir, "LaunchAgents")
      const crontab = { text: "" }
      return {
        layer: layer(configOf(platform, dir, crontab)),
        plant: (title) =>
          Effect.sync(() => {
            if (platform === "darwin") writeFileSync(path.join(agents, `bun.cron.${title}.plist`), "<plist/>")
            else crontab.text = `${crontab.text}\n0 3 * * * /usr/bin/backup # bun-cron: ${title}\n15 * * * * /usr/bin/opencode-wake-lookalike`
          }),
      }
    }),
  )

/** `text` in double quotes, as a script's string literal: these paths and versions hold no quote or backslash. */
const quoted = (text: string) => `"${text}"`

/** Runs `use` against the Bun.cron backstop built from `config`. */
const on = (config: Config) => <A, E>(use: (backstop: Backstop["Service"]) => Effect.Effect<A, E>) => Backstop.use(use).pipe(Effect.provide(layer(config)))

describe("a job", () => {
  scratchTest("registers through the configured bun with its entry file, cron and title, and its entry file goes with it", (dir) =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = []
      const config = configOf("darwin", dir, { text: "" }, calls)
      const job = { id: "w000001", title: "opencode-wake-w000001", directory: "/work/app" }
      yield* on(config)((backstop) => backstop.register(job, { cron: "30 14 5 11 *", recurring: false }))
      const file = path.join(config.jobs, "opencode-wake-w000001.ts")
      expect(calls[0]?.slice(0, 2)).toEqual(["/opt/bun/bin/bun", "-e"])
      expect(calls[0]?.slice(3)).toEqual([file, "30 14 5 11 *", "opencode-wake-w000001"])
      const entry = readFileSync(file, "utf8")
      expect(entry).toContain('import { scheduled } from "/dotfiles/opencode/cmd/wake/backstop.ts"')
      expect(entry).toContain('"opencode": "/home/me/.local/bin/opencode"')
      expect(entry).not.toContain("SECRET_TOKEN")
      expect(entry).not.toContain('"PATH"')
      yield* on(config)((backstop) => backstop.remove(job.title))
      expect(existsSync(file)).toBe(false)
      expect(readdirSync(config.launchAgents)).toEqual([])
    }),
  )

  scratchTest("its entry file, run by bun, hands the script its descriptor", (dir) =>
    Effect.gen(function* () {
      const out = path.join(dir, "descriptor.json")
      const script = path.join(dir, "script.ts")
      writeFileSync(script, `export const scheduled = (descriptor: unknown) => Bun.write(${JSON.stringify(out)}, JSON.stringify(descriptor))\n`)
      const config = { ...configOf("darwin", dir, { text: "" }), script }
      yield* on(config)((backstop) => backstop.register({ id: "w000009", title: "opencode-wake-w000009", directory: "/work/app" }, { cron: "* * * * *", recurring: true }))
      const file = path.join(config.jobs, "opencode-wake-w000009.ts")
      const ran = yield* exec([process.execPath, "-e", `const job = await import(${JSON.stringify(file)}); await job.default.scheduled()`])
      expect(ran.exitCode).toBe(0)
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
        id: "w000009",
        title: "opencode-wake-w000009",
        directory: "/work/app",
        opencode: "/home/me/.local/bin/opencode",
        env: { HOME: "/home/me", XDG_STATE_HOME: "/state", OPENCODE_CONFIG_DIR: "/config" },
      })
    }),
  )

  /** A build's plugin tree in `share` whose backstop script writes `name` to `out`, the share's `current.plugins` link pointed at it. */
  const installTree = (share: string, version: string, out: string) => {
    const tree = path.join(share, `opencode-${version}.plugins`)
    mkdirSync(path.join(tree, "opencode", "cmd", "wake"), { recursive: true })
    writeFileSync(path.join(tree, "opencode", "cmd", "wake", "backstop.ts"), `export const scheduled = () => Bun.write(${quoted(out)}, ${quoted(version)})\n`)
    rmSync(path.join(share, "current.plugins"), { force: true })
    symlinkSync(path.basename(tree), path.join(share, "current.plugins"))
    return path.join(tree, "opencode", "cmd", "wake", "backstop.ts")
  }
  const A = "2.3.0-prime.aaaaaaaa.11111111.tree"
  const B = "2.3.0-prime.bbbbbbbb.22222222.tree"

  scratchTest("an entry file registered by a server in tree A still imports after A is pruned and B is installed, through the link", (dir) =>
    Effect.gen(function* () {
      const share = path.join(dir, "share")
      const out = path.join(dir, "fired")
      const config = { ...configOf("darwin", dir, { text: "" }), script: installTree(share, A, out) }
      yield* on(config)((backstop) => backstop.register({ id: "w000010", title: "opencode-wake-w000010", directory: "/work/app" }, { cron: "* * * * *", recurring: true }))
      installTree(share, B, out)
      rmSync(path.join(share, `opencode-${A}.plugins`), { recursive: true })
      const file = path.join(config.jobs, "opencode-wake-w000010.ts")
      const ran = yield* exec([process.execPath, "-e", `const job = await import(${quoted(file)}); await job.default.scheduled()`])
      expect(ran.stderr).toBe("")
      expect(ran.exitCode).toBe(0)
      expect(readFileSync(out, "utf8")).toBe(B)
    }),
  )

  scratchTest("an entry file written into tree A before the link was used goes through it from the next start's listing", (dir) =>
    Effect.gen(function* () {
      const share = path.join(dir, "share")
      const out = path.join(dir, "fired")
      const script = installTree(share, A, out)
      const config = configOf("darwin", dir, { text: "" })
      mkdirSync(config.jobs, { recursive: true })
      const file = path.join(config.jobs, "opencode-wake-w000011.ts")
      writeFileSync(file, `// old\nimport { scheduled } from ${quoted(script)}\n\nexport default { scheduled: () => scheduled({}) }\n`)
      writeFileSync(path.join(config.launchAgents, "bun.cron.opencode-wake-w000011.plist"), "<plist/>")
      expect(yield* on(config)((backstop) => backstop.titles)).toEqual(["opencode-wake-w000011"])
      installTree(share, B, out)
      rmSync(path.join(share, `opencode-${A}.plugins`), { recursive: true })
      const ran = yield* exec([process.execPath, "-e", `const job = await import(${quoted(file)}); await job.default.scheduled()`])
      expect(ran.exitCode).toBe(0)
      expect(readFileSync(out, "utf8")).toBe(B)
    }),
  )

  scratchTest("a refused registration says what the scheduler said", (dir) =>
    Effect.gen(function* () {
      const config = { ...configOf("darwin", dir, { text: "" }), exec: (() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "launchctl: bootstrap failed\n" })) satisfies Exec }
      const failure = yield* Effect.flip(on(config)((backstop) => backstop.register({ id: "w1", title: "opencode-wake-w1", directory: "/" }, { cron: "* * * * *", recurring: true })))
      expect(failure.message).toBe("Bun.cron exited 1: launchctl: bootstrap failed")
    }),
  )

  scratchTest("an OS with no supported scheduler refuses to list", (dir) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(on({ ...configOf("darwin", dir, { text: "" }), platform: "win32" })((backstop) => backstop.titles))
      expect(failure._tag).toBe("BackstopRefused")
    }),
  )
})

describe("listing", () => {
  test("keeps only wake titles, from plist names and from marked crontab lines", () => {
    expect(plistTitles(["bun.cron.opencode-wake-w1.plist", "bun.cron.nightly.plist", "com.cvr.okra.schedule-x.plist", "bun.cron.opencode-wake-.plist"])).toEqual(["opencode-wake-w1"])
    expect(crontabTitles(["*/5 * * * * run # bun-cron: opencode-wake-w2", "0 3 * * * opencode-wake-w3 # mine", "# bun-cron: other"].join("\n"))).toEqual(["opencode-wake-w2"])
  })

  test("a tree's script goes through current.plugins only where the link holds it; a checkout's, a link's or a near miss stays", () => {
    const tree = "/s/opencode-2.3.0-prime.aaaaaaaa.11111111.tree.plugins/opencode/cmd/wake/backstop.ts"
    const through = "/s/current.plugins/opencode/cmd/wake/backstop.ts"
    expect(stableScript(tree, (each) => each === through)).toBe(through)
    expect(stableScript(tree, () => false)).toBe(tree)
    for (const other of ["/dotfiles/opencode/cmd/wake/backstop.ts", through, "/s/x.plugins/opencode/cmd/wake/backstop.ts", "/s/opencode-2.3.0.plugins/cmd/wake/backstop.ts"])
      expect(stableScript(other, () => true)).toBe(other)
    const entry = `// x\nimport { scheduled } from ${quoted(tree)}\n\nexport default {}\n`
    expect(relinked(entry, () => true)).toBe(entry.replace(tree, through))
    expect(relinked(entry, () => false)).toBe(entry)
    expect(relinked("not an entry\n", () => true)).toBe("not an entry\n")
  })

  test("exec runs a program and says how it went; one that cannot start reads as exit 127", async () => {
    expect(await Effect.runPromise(exec(["/bin/sh", "-c", "echo hi; exit 4"]))).toEqual({ exitCode: 4, stdout: "hi\n", stderr: "" })
    expect((await Effect.runPromise(exec(["/no/such/program"]))).exitCode).toBe(127)
  })
})
