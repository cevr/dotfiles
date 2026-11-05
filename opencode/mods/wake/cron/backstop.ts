// The OS backstop through Bun.cron: a launchd agent on macOS
// (~/Library/LaunchAgents/bun.cron.<title>.plist), a crontab line marked
// `# bun-cron: <title>` on Linux. Bun.cron needs the job's script by path and
// hands it no title or environment (a launchd job gets a bare PATH, and the
// controller carries only `cron`, `type` and `scheduledTime`), so each job gets
// its own entry file, `<jobs>/<title>.ts`, that calls the shared script
// (cmd/wake/backstop.ts) with the job's descriptor written in.
//
// It registers through a real `bun`, not the process it runs in: inside the
// compiled OpenCode binary, Bun.cron writes that binary as the job's program,
// and the job would run OpenCode's CLI instead of the script (measured on
// 2.2.5-prime). Removing goes through Bun.cron.remove too, which only touches
// its own launchd label or its own marked crontab line. Listing reads the
// LaunchAgents directory, or `crontab -l` for the marked lines, and keeps the
// wake titles only.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { carried, type Descriptor, idOfTitle, type Job, type Schedule } from "../backstop.ts"
import { Backstop, BackstopRefused } from "../service.ts"

/** What a command run said. */
export interface Ran {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a program by argv and says how it went; never fails. */
export type Exec = (argv: ReadonlyArray<string>) => Effect.Effect<Ran>

export interface Config {
  /** A real bun, by absolute path. */
  readonly bun: string
  /** The shared script each job's entry file calls (cmd/wake/backstop.ts), by absolute path. */
  readonly script: string
  /** Where the entry files are written. */
  readonly jobs: string
  /** The `opencode` launcher the job starts OpenCode with. */
  readonly opencode: string
  /** The server's environment, whose state and config the job's OpenCode must share. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: NodeJS.Platform
  /** macOS: where launchd agents are. */
  readonly launchAgents: string
  readonly exec: Exec
}

const REGISTER = "await Bun.cron(process.argv[1], process.argv[2], process.argv[3])"
const REMOVE = "await Bun.cron.remove(process.argv[1])"
const PLIST = /^bun\.cron\.(.+)\.plist$/
const MARKER = /# bun-cron: (\S+)/

/** The entry file of a job: the shared script, called with the job's descriptor. */
export const entryOf = (script: string, descriptor: Descriptor): string =>
  [
    `// Written by the wake plugin (opencode/cmd/wake) for ${descriptor.title}: the OS job's script. Removed with its job.`,
    `import { scheduled } from ${JSON.stringify(script)}`,
    "",
    `export default { scheduled: () => scheduled(${JSON.stringify(descriptor, null, 2)}) }`,
    "",
  ].join("\n")

/** The wake titles among a LaunchAgents directory's files. */
export const plistTitles = (files: ReadonlyArray<string>): ReadonlyArray<string> =>
  files.flatMap((file) => {
    const title = PLIST.exec(file)?.[1]
    return title !== undefined && idOfTitle(title) !== undefined ? [title] : []
  })

/** The wake titles among a crontab's marked lines; an unmarked line is never read as one. */
export const crontabTitles = (crontab: string): ReadonlyArray<string> =>
  crontab.split("\n").flatMap((line) => {
    const title = MARKER.exec(line)?.[1]
    return title !== undefined && idOfTitle(title) !== undefined ? [title] : []
  })

const attempt = <A,>(what: string, body: () => A) =>
  Effect.try({ try: body, catch: (cause) => new BackstopRefused({ message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}` }) })

const ranOk = (what: string) => (ran: Ran) =>
  ran.exitCode === 0 ? Effect.void : Effect.fail(new BackstopRefused({ message: `${what} exited ${ran.exitCode}: ${(ran.stderr || ran.stdout).trim()}` }))

export const layer = (config: Config) => {
  const fileOf = (title: string) => path.join(config.jobs, `${title}.ts`)
  return Layer.succeed(Backstop, {
    register: (job: Job, schedule: Schedule) =>
      Effect.gen(function* () {
        const descriptor: Descriptor = { ...job, opencode: config.opencode, env: carried(config.env) }
        const file = fileOf(job.title)
        yield* attempt("the job's script was not written", () => {
          mkdirSync(config.jobs, { recursive: true })
          writeFileSync(file, entryOf(config.script, descriptor))
        })
        yield* config.exec([config.bun, "-e", REGISTER, file, schedule.cron, job.title]).pipe(Effect.flatMap(ranOk("Bun.cron")))
      }),
    remove: (title: string) =>
      config.exec([config.bun, "-e", REMOVE, title]).pipe(
        Effect.flatMap(ranOk("Bun.cron.remove")),
        Effect.andThen(attempt("the job's script was not removed", () => rmSync(fileOf(title), { force: true }))),
      ),
    titles: Effect.gen(function* () {
      if (config.platform === "darwin")
        return plistTitles(yield* attempt("the launchd agents were not read", () => readdirSync(config.launchAgents)).pipe(Effect.orElseSucceed((): Array<string> => [])))
      if (config.platform === "linux") {
        const ran = yield* config.exec(["crontab", "-l"])
        if (ran.exitCode !== 0 && /no crontab/i.test(ran.stderr)) return []
        yield* ranOk("crontab -l")(ran)
        return crontabTitles(ran.stdout)
      }
      return yield* new BackstopRefused({ message: `no OS scheduler is supported on ${config.platform}` })
    }),
  })
}

/** Run argv as a child process, with its output; one that cannot start reads as exit 127. */
export const exec: Exec = (argv) =>
  Effect.tryPromise(async () => {
    const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { exitCode, stdout, stderr }
  }).pipe(Effect.orElseSucceed((): Ran => ({ exitCode: 127, stdout: "", stderr: `${argv[0] ?? ""} did not start` })))
