// accept: deep (25.3 s alone on a quiet host: 1-minute load 33.4–69.7 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// The rift tool and the tool-name repair in real OpenCode (the fork, through
// its SDK) on the scripted model and the real `rift` CLI, in a scratch HOME.
// The model makes a Rift for a branch, commits in it, lists it, is refused
// removing it while the commit is found nowhere else, removes it with force,
// calls `shll` and is told to call `shell`, and calls OpenCode's
// `opencode_worktree_create`, which is no longer offered. In a second run it
// commits in a Rift and lands it: one push to the bare origin's main, the
// Rift trashed, and the accept check's wake after the turn. The plugins on their
// own are tested beside their code in mods/rift, cmd/rift, mods/tool-names
// and cmd/tool-names.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Result, Spec } from "./rift/run.ts"
import { BRANCH, COMMIT_SUBJECT, DONE, LAND_SUBJECT, LAND_TASK, TASK } from "./rift/sim.ts"
import { owned } from "./owned.ts"
import { scratch as scratchDir } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/rift.test.ts: the OpenCode runs skip. Set OPENCODE_DEV to the fork.")
// Rift needs copy-on-write: APFS on the Mac.
const riftHere = process.platform === "darwin" && Bun.which("rift") !== null
if (!riftHere) console.warn("tests/rift.test.ts: the OpenCode runs skip. They need macOS and the rift CLI.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = scratchDir("rift-e2e-").path
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/rift/run.ts. */
const run = async (name: string, task = TASK, wake?: string): Promise<Result> => {
  const base = join(scratch, name)
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  writeFileSync(
    file,
    JSON.stringify({ base, fork: resolve(fork ?? ""), rift: join(ROOT, "cmd/rift"), toolNames: join(ROOT, "cmd/tool-names"), task, ...(wake === undefined ? {} : { wake }) } satisfies Spec),
  )
  const child = owned([process.execPath, join(import.meta.dir, "rift/run.ts"), file], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 120_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  clearTimeout(timer)
  const result = join(base, "result.json")
  if (child.exitCode !== 0 || !existsSync(result)) throw new Error(`the ${name} run failed (exit ${child.exitCode}):\n${stdout}\n${stderr}`)
  return JSON.parse(readFileSync(result, "utf8")) as Result
}

interface ToolPart {
  readonly type: "tool"
  readonly name: string
  readonly state: {
    readonly status: string
    readonly input: Record<string, unknown>
    readonly content?: ReadonlyArray<{ readonly text?: string }>
    readonly error?: unknown
  }
}
const toolParts = (messages: unknown): ToolPart[] =>
  (messages as Array<{ type: string; content?: Array<{ type: string }> }>)
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part): part is ToolPart => part.type === "tool")

/** Everything a tool part says: its content's text and its error. */
const said = (part: ToolPart | undefined): string =>
  part === undefined
    ? ""
    : [...(part.state.content ?? []).map((item) => item.text ?? ""), ...(part.state.error === undefined ? [] : [JSON.stringify(part.state.error)])].join("\n")

const RUN_MS = 150_000

describe.skipIf(!fork || !riftHere)("in real OpenCode, on the scripted model and real Rift", () => {
  test(
    "an agent makes, lists and removes a Rift through the rift tool, is told the right name for shll, and has no worktree tools",
    async () => {
      const result = await run("flow")
      const offered = result.seen.find((item) => item.task.endsWith(TASK))
      expect(offered?.tools).toContain("rift")
      // session_move, offered beside them, is still in the request: they are gone, not merely unlisted.
      expect(offered?.named).toEqual(["session_move"])

      const [create, commit, list, refused, forced, misspelled, worktree, ...rest] = toolParts(result.messages)
      expect(rest).toEqual([])
      expect(create?.name).toBe("rift")
      expect(create?.state.status).toBe("completed")
      expect(said(create)).toContain(`Created the Rift ${result.rift} from ${result.source}, on branch ${BRANCH}.`)
      expect(said(create)).toContain(`session_move tool (directory: "${result.rift}")`)
      expect(commit?.state.status).toBe("completed")
      expect(said(list)).toContain(`- ${result.rift} · branch ${BRANCH} · 1 unpushed`)
      expect(refused?.state.status).toBe("error")
      expect(said(refused)).toContain(`${result.rift} holds work found nowhere else:`)
      expect(said(refused)).toContain(COMMIT_SUBJECT)
      expect(forced?.state.status).toBe("completed")
      expect(said(forced)).toContain(`Moved the Rift ${result.rift} (branch ${BRANCH}) to Rift's trash; it held 1 unpushed.`)
      expect(existsSync(result.rift)).toBe(false)
      expect(misspelled?.name).toBe("shll")
      expect(misspelled?.state.status).toBe("error")
      expect(said(misspelled)).toContain('There is no \\"shll\\" tool; did you mean \\"shell\\"? Call \\"shell\\" with the same input.')
      expect(worktree?.state.status).toBe("error")
      expect(said(worktree)).toContain('No tool named \\"opencode_worktree_create\\"')
      expect(JSON.stringify(result.messages)).toContain(DONE)
    },
    RUN_MS,
  )

  test(
    "an agent lands a Rift: one push to main from the integration Rift, the Rift trashed, then the accept check's wake",
    async () => {
      const result = await run("land", LAND_TASK, "rift land: the accept check for")
      const [create, commit, land, ...rest] = toolParts(result.messages)
      expect(rest).toEqual([])
      expect(create?.state.status).toBe("completed")
      expect(commit?.state.status).toBe("completed")
      expect(land?.state.status).toBe("completed")
      const integration = result.rift.replace(/feat-x$/, "integrate")
      expect(said(land)).toContain(`Landed 1 Rift(s) as one push: `)
      expect(said(land)).toContain(`${LAND_SUBJECT} to main (merged ${BRANCH}; the gate passed in `)
      expect(said(land)).toContain(`To the trash: ${result.rift}.`)
      expect(said(land)).toContain(`The accept check runs in the background in ${integration} on the batch since `)
      // The branch's commit is origin's main; the Rift went, the integration Rift stays for the next batch.
      expect(Bun.spawnSync(["git", "-C", result.origin, "log", "-1", "--format=%s", "main"]).stdout.toString().trim()).toBe(LAND_SUBJECT)
      expect(existsSync(result.rift)).toBe(false)
      expect(existsSync(integration)).toBe(true)
      const transcript = JSON.stringify(result.messages)
      expect(transcript).toMatch(/rift land: the accept check for feat\/x passed in \d+s\./)
      expect(transcript).toContain(DONE)
    },
    RUN_MS,
  )
})
