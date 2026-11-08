// The web plugin in real OpenCode (the fork, through its SDK) on the scripted
// model, with stand-in search providers and a loopback site. A provider choice
// saved from an earlier consent form (`flaky`, which fails) does not stop a
// subagent's websearch: it asks no form and answers from `steady`. webfetch
// answers a PDF as its text, a body over 5 MB cut under a note, and a 404 with
// what to do instead. The plugin on its own is tested beside its code in
// mods/web and cmd/web.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Result, Spec } from "./web/run.ts"
import { BIG_PATH, MISSING_PATH, PDF_PATH, PDF_TEXT, STEADY_URL } from "./web/sim.ts"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/web.test.ts: the OpenCode runs skip. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = mkdtempSync(join(tmpdir(), "web-e2e-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/web/run.ts. */
const run = async (): Promise<Result> => {
  const base = join(scratch, "run")
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  writeFileSync(file, JSON.stringify({ base, fork: resolve(fork ?? ""), web: join(ROOT, "cmd/web") } satisfies Spec))
  const child = owned([process.execPath, join(import.meta.dir, "web/run.ts"), file], {
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
  const timer = setTimeout(() => child.kill(), 150_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  clearTimeout(timer)
  const result = join(base, "result.json")
  if (child.exitCode !== 0 || !existsSync(result)) throw new Error(`the web run failed (exit ${child.exitCode}):\n${stdout}\n${stderr}`)
  return JSON.parse(readFileSync(result, "utf8")) as Result
}

interface ToolPart {
  readonly type: "tool"
  readonly name: string
  readonly state: {
    readonly status: string
    readonly input: Record<string, unknown>
    readonly content?: ReadonlyArray<{ readonly text?: string }>
    readonly metadata?: Record<string, unknown>
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

const RUN_MS = 180_000

describe.skipIf(!fork)("in real OpenCode, on the scripted model", () => {
  test(
    "a subagent searches past a saved failing choice with no form, and webfetch reads a PDF, cuts a large body and answers a 404",
    async () => {
      const result = await run()

      // Before the plugin: the consent form was answered, choosing flaky, and the search failed on it.
      expect(result.forms.filter((form) => form.instance === "before").map((form) => form.answer)).toEqual([{ choice: "choose" }, { provider: "flaky" }])
      const [picked] = toolParts(result.before)
      expect(picked?.name).toBe("websearch")
      expect(picked?.state.status).toBe("error")

      // With the plugin: no form, and the subagent's search answers from steady.
      expect(result.forms.filter((form) => form.instance === "with-web")).toEqual([])
      const [subagent, pdf, big, missing, ...rest] = toolParts(result.messages)
      expect(rest).toEqual([])
      expect(subagent?.name).toBe("subagent")
      expect(subagent?.state.status).toBe("completed")
      const children = Object.values(result.children).filter((messages) => messages !== undefined)
      expect(children).toHaveLength(1)
      const [search, ...childRest] = toolParts(children[0])
      expect(childRest).toEqual([])
      expect(search?.name).toBe("websearch")
      expect(search?.state.status).toBe("completed")
      expect(said(search)).toContain(STEADY_URL)
      expect(said(search)).toContain("steady answered the investigative judgment")

      expect(pdf?.state.input.url).toEndWith(PDF_PATH)
      if (Bun.which("pdftotext") === null) {
        expect(said(pdf)).toContain("pdftotext is not installed on this machine")
      } else {
        expect(pdf?.state.status).toBe("completed")
        expect(said(pdf)).toContain(PDF_TEXT)
      }

      expect(big?.state.input.url).toEndWith(BIG_PATH)
      expect(big?.state.status).toBe("completed")
      expect(said(big)).toContain("[webfetch: the body cut to the first 512 KB of 6 MB.")
      expect(said(big)).toContain("line of a large body")

      expect(missing?.state.input.url).toEndWith(MISSING_PATH)
      expect(missing?.state.status).toBe("error")
      expect(said(missing)).toContain("answered 404: no page at that URL (a guessed docs path). Find the real page with websearch")
    },
    RUN_MS,
  )
})
