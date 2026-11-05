// The Bun.cron backstop over a stand-in scheduler: an exec that does what
// Bun.cron does to a LaunchAgents directory (macOS) or a crontab (Linux), so
// the laws run without registering a real job. The job's entry file is run by
// a real bun against a stand-in script, to show it hands the descriptor over.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { backstopLaws } from "../laws.ts"
import { Backstop } from "../service.ts"
import { type Config, crontabTitles, type Exec, exec, layer, plistTitles } from "./backstop.ts"

const scratch = () => mkdtempSync(path.join(tmpdir(), "wake-cron-"))

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
    Effect.sync(() => {
      const dir = scratch()
      const agents = path.join(dir, "LaunchAgents")
      Bun.spawnSync(["mkdir", "-p", agents])
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

describe("a job", () => {
  test("registers through the configured bun with its entry file, cron and title, and its entry file goes with it", async () => {
    const dir = scratch()
    Bun.spawnSync(["mkdir", "-p", path.join(dir, "LaunchAgents")])
    const calls: Array<ReadonlyArray<string>> = []
    const config = configOf("darwin", dir, { text: "" }, calls)
    const job = { id: "w000001", title: "opencode-wake-w000001", directory: "/work/app" }
    await Effect.runPromise(Backstop.use((backstop) => backstop.register(job, { cron: "30 14 5 11 *", recurring: false })).pipe(Effect.provide(layer(config))))
    const file = path.join(config.jobs, "opencode-wake-w000001.ts")
    expect(calls[0]?.slice(0, 2)).toEqual(["/opt/bun/bin/bun", "-e"])
    expect(calls[0]?.slice(3)).toEqual([file, "30 14 5 11 *", "opencode-wake-w000001"])
    const entry = await Bun.file(file).text()
    expect(entry).toContain('import { scheduled } from "/dotfiles/opencode/cmd/wake/backstop.ts"')
    expect(entry).toContain('"opencode": "/home/me/.local/bin/opencode"')
    expect(entry).not.toContain("SECRET_TOKEN")
    expect(entry).not.toContain('"PATH"')
    await Effect.runPromise(Backstop.use((backstop) => backstop.remove(job.title)).pipe(Effect.provide(layer(config))))
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(config.launchAgents)).toEqual([])
  })

  test("its entry file, run by bun, hands the script its descriptor", async () => {
    const dir = scratch()
    const out = path.join(dir, "descriptor.json")
    const script = path.join(dir, "script.ts")
    writeFileSync(script, `export const scheduled = (descriptor: unknown) => Bun.write(${JSON.stringify(out)}, JSON.stringify(descriptor))\n`)
    Bun.spawnSync(["mkdir", "-p", path.join(dir, "LaunchAgents")])
    const config = { ...configOf("darwin", dir, { text: "" }), script }
    await Effect.runPromise(
      Backstop.use((backstop) => backstop.register({ id: "w000009", title: "opencode-wake-w000009", directory: "/work/app" }, { cron: "* * * * *", recurring: true })).pipe(
        Effect.provide(layer(config)),
      ),
    )
    const file = path.join(config.jobs, "opencode-wake-w000009.ts")
    const ran = Bun.spawnSync([process.execPath, "-e", `const job = await import(${JSON.stringify(file)}); await job.default.scheduled()`])
    expect(ran.exitCode).toBe(0)
    expect(JSON.parse(await Bun.file(out).text())).toEqual({
      id: "w000009",
      title: "opencode-wake-w000009",
      directory: "/work/app",
      opencode: "/home/me/.local/bin/opencode",
      env: { HOME: "/home/me", XDG_STATE_HOME: "/state", OPENCODE_CONFIG_DIR: "/config" },
    })
  })

  test("a refused registration says what the scheduler said", async () => {
    const dir = scratch()
    const config = { ...configOf("darwin", dir, { text: "" }), exec: (() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "launchctl: bootstrap failed\n" })) satisfies Exec }
    const failure = await Effect.runPromise(
      Backstop.use((backstop) => backstop.register({ id: "w1", title: "opencode-wake-w1", directory: "/" }, { cron: "* * * * *", recurring: true })).pipe(
        Effect.flip,
        Effect.provide(layer(config)),
      ),
    )
    expect(failure.message).toBe("Bun.cron exited 1: launchctl: bootstrap failed")
  })

  test("an OS with no supported scheduler refuses to list", async () => {
    const failure = await Effect.runPromise(Backstop.use((backstop) => backstop.titles).pipe(Effect.flip, Effect.provide(layer({ ...configOf("darwin", scratch(), { text: "" }), platform: "win32" }))))
    expect(failure._tag).toBe("BackstopRefused")
  })
})

describe("listing", () => {
  test("keeps only wake titles, from plist names and from marked crontab lines", () => {
    expect(plistTitles(["bun.cron.opencode-wake-w1.plist", "bun.cron.nightly.plist", "com.cvr.okra.schedule-x.plist", "bun.cron.opencode-wake-.plist"])).toEqual(["opencode-wake-w1"])
    expect(crontabTitles(["*/5 * * * * run # bun-cron: opencode-wake-w2", "0 3 * * * opencode-wake-w3 # mine", "# bun-cron: other"].join("\n"))).toEqual(["opencode-wake-w2"])
  })

  test("exec runs a program and says how it went; one that cannot start reads as exit 127", async () => {
    expect(await Effect.runPromise(exec(["/bin/sh", "-c", "echo hi; exit 4"]))).toEqual({ exitCode: 4, stdout: "hi\n", stderr: "" })
    expect((await Effect.runPromise(exec(["/no/such/program"]))).exitCode).toBe(127)
  })
})
