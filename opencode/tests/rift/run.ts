/**
 * One rift run in real OpenCode (the fork, embedded through its SDK), on the
 * scripted model, with the rift and tool-names plugins loaded from config as
 * the owner would load them. The test starts it in a child process whose HOME
 * and XDG dirs are a scratch dir, so Rift's registry is the run's own:
 * `bun tests/rift/run.ts <spec.json>`. The work dir is a warm source: a git
 * repository with one commit pushed to a bare origin, made a Rift root with
 * `rift init`. It writes the session's messages and the model's requests to
 * `<base>/result.json`.
 *
 * @module
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { serve, type Seen } from "./sim.ts"

export interface Spec {
  readonly base: string
  readonly fork: string
  readonly rift: string
  readonly toolNames: string
  /** The prompt: a task the sim scripts. */
  readonly task: string
}

export interface Result {
  readonly messages: unknown
  readonly seen: ReadonlyArray<Seen>
  /** The warm source, as Rift names it. */
  readonly source: string
  /** Where the Rift for the branch is made. */
  readonly rift: string
}

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec
const config = join(spec.base, "config")
mkdirSync(config, { recursive: true })

const sh = (cwd: string, ...argv: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  if (ran.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${ran.stderr.toString()}`)
}
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  sh(cwd, "git", "-c", "user.name=rift", "-c", "user.email=rift@example.com", "-c", "commit.gpgsign=false", ...args)

mkdirSync(join(spec.base, "code/work"), { recursive: true })
const work = realpathSync(join(spec.base, "code/work"))
const origin = join(spec.base, "origin.git")
git(spec.base, "init", "-q", "--bare", "-b", "main", origin)
git(work, "init", "-q", "-b", "main")
writeFileSync(join(work, "README.md"), "work\n")
git(work, "add", "README.md")
git(work, "commit", "-q", "-m", "first")
git(work, "remote", "add", "origin", origin)
git(work, "push", "-q", "-u", "origin", "main")
sh(work, "rift", "init", "--here")
const rift = join(dirname(work), ".rifts", basename(work), "feat-x")

const sim = serve(rift)
const content = {
  model: "sim/sim-model",
  providers: {
    sim: {
      name: "Sim",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${sim.server.port}/v1`, apiKey: "sim-key" },
      models: {
        "sim-model": {
          name: "Sim",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 128_000, output: 16_000 },
        },
      },
    },
  },
  // On this machine's PATH there may be no workrift; the run names the Mac's rift outright.
  plugins: [{ package: spec.rift, options: { workrift: false } }, spec.toolNames],
}

/** As much of the fork's SDK as the run uses; the fork is found at run time, so it is typed here. */
interface Embedded {
  readonly sessions: {
    readonly create: (input: { location: { directory: string } }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
    readonly context: (input: { sessionID: string }) => Promise<unknown>
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
  readonly close: () => Promise<void>
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: Record<string, unknown>) => Promise<Embedded> }
}
const { OpenCode } = (await import(join(spec.fork, "packages/sdk/src/index.ts"))) as Sdk
const opencode = await OpenCode.create({
  events: { persist: true },
  config: { directory: config, project: false, content: JSON.stringify(content) },
})

try {
  const session = await opencode.sessions.create({ location: { directory: work } })
  await opencode.sessions.prompt({ sessionID: session.id, text: spec.task })
  await opencode.experimental.session.wait({ sessionID: session.id })
  const result: Result = { messages: await opencode.sessions.context({ sessionID: session.id }), seen: sim.seen, source: work, rift }
  writeFileSync(join(spec.base, "result.json"), JSON.stringify(result, null, 2))
} finally {
  await opencode.close()
  sim.server.stop(true)
}
process.exit(0)
