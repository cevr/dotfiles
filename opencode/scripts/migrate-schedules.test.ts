import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { scratch } from "../tests/scratch.ts"
import { parseArgs, plan, type Row, render, secondsOf } from "./migrate-schedules.ts"

const NOW = Date.parse("2026-11-06T18:00:00Z")
const PROMPTS = "/state/opencode-wake/schedules"
const LONG = `Sabbath rest starts. ${"Start no new agent; let running ones finish. ".repeat(8)}`

const row = (fields: Partial<Row> & Pick<Row, "id" | "when">): Row => ({
  session_id: "ses_a",
  name: null,
  action: JSON.stringify({ type: "prompt", prompt: "Check it." }),
  tz: "UTC",
  check: null,
  next_due_at: null,
  ends_at: null,
  remaining_runs: null,
  state: null,
  directory: "/work/app",
  ...fields,
})

/** The shapes active on the workbox when this was written: two one-time prompts and a PR watch. */
const rows: ReadonlyArray<Row> = [
  row({ id: "sch_rest", name: "sync: Sabbath rest starts", when: '{"type":"at","at":"2026-11-06T21:35:00Z"}', next_due_at: Date.parse("2026-11-06T21:35:00Z"), action: JSON.stringify({ type: "prompt", prompt: LONG }) }),
  row({ id: "sch_short", name: "ping", when: '{"type":"in","in":"10 minutes"}', next_due_at: NOW - 5000 }),
  row({
    id: "sch_watch",
    name: "open PR review watch",
    when: '{"type":"every","every":"15 minutes"}',
    check: JSON.stringify({ mode: "if", condition: { type: "shell", run: "gh pr view 1 --json state", changes: true } }),
    next_due_at: NOW + 60_000,
    ends_at: NOW + 3 * 86_400_000,
    state: JSON.stringify({ stdout: "1 OPEN REVIEW_REQUIRED\n" }),
    action: JSON.stringify({ type: "prompt", prompt: `A review changed. ${"Read each PR and answer. ".repeat(20)}` }),
  }),
  row({ id: "sch_cron", when: '{"type":"cron","cron":"0 9 * * 1"}' }),
  row({ id: "sch_code", when: '{"type":"every","every":"1 hour"}', check: JSON.stringify({ mode: "if", condition: { type: "code", code: "return true" } }) }),
  row({ id: "sch_until", when: '{"type":"every","every":"30 seconds"}', check: JSON.stringify({ mode: "until", condition: { type: "shell", run: "curl -s /health", is: "ok" } }) }),
]

describe("plan", () => {
  const plans = plan(rows, NOW, PROMPTS)
  const of = (id: string) => plans.find((item) => item.schedule.id === id)

  test("a one-time prompt becomes a wake at its next run; a long prompt goes to a file the note names", () => {
    expect(of("sch_rest")).toMatchObject({
      sessionID: "ses_a",
      directory: "/work/app",
      ask: { sessionID: "ses_a", wake: { at: "2026-11-06T21:35:00.000Z", note: `sync: Sabbath rest starts (was OpenCode schedule sch_rest): read ${PROMPTS}/sch_rest.md and do what it says.` } },
      prompt: { file: `${PROMPTS}/sch_rest.md` },
      differs: [],
    })
    const rest = of("sch_rest")
    expect(rest !== undefined && "prompt" in rest ? rest.prompt?.text : "").toContain(LONG)
    expect(of("sch_short")).toMatchObject({ ask: { wake: { afterSeconds: 0, note: "ping: Check it." } } })
    expect(of("sch_short")).not.toHaveProperty("prompt")
  })

  test("an every schedule with a changes check becomes a repeating change monitor from the stored output, ending when it ended", () => {
    expect(of("sch_watch")).toMatchObject({
      ask: {
        monitor: {
          command: "gh pr view 1 --json state",
          cwd: "/work/app",
          intervalSeconds: 900,
          timeoutSeconds: 3 * 86_400,
          repeat: "change",
          baseline: "1 OPEN REVIEW_REQUIRED\n",
        },
      },
      differs: [],
    })
  })

  test("an until check becomes a one-shot monitor; is becomes an anchored pattern, and says so", () => {
    const until = of("sch_until")
    expect(until).toMatchObject({ ask: { monitor: { command: "curl -s /health", intervalSeconds: 30, until: "^ok$", timeoutSeconds: 86_400 } } })
    expect(until !== undefined && "differs" in until ? until.differs.join("\n") : "").toContain("whole line")
  })

  test("cron and a Code Mode check are skipped, saying why", () => {
    expect(of("sch_cron")).toMatchObject({ skip: expect.stringContaining("cron (0 9 * * 1, UTC) has no wake equivalent") })
    expect(of("sch_code")).toMatchObject({ skip: "its check is Code Mode, which a monitor cannot run" })
  })

  test("secondsOf reads the schedule's durations", () => {
    expect(secondsOf("15 minutes")).toBe(900)
    expect(secondsOf("30 seconds")).toBe(30)
    expect(secondsOf("2 hours")).toBe(7200)
    expect(secondsOf("1 day")).toBe(86_400)
    expect(secondsOf("soon")).toBeUndefined()
  })
})

describe("the dry run", () => {
  test("prints each schedule's entry, prompt file, differences and pause, and touches nothing", async () => {
    using held = scratch("migrate-schedules-")
    const dir = held.path
    const file = join(dir, "rows.json")
    // The script plans at the real clock, so the PR watch's end moves with it; a fixed end would expire.
    writeFileSync(file, JSON.stringify(rows.map((item) => (item.id === "sch_watch" ? { ...item, ends_at: Date.now() + 3 * 86_400_000 } : item))))
    const prompts = join(dir, "prompts")
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "migrate-schedules.ts"), "--rows", file, "--prompts", prompts], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: dir } })
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(code).toBe(0)
    expect(out).toStartWith("6 active schedule(s) (dry run: nothing is set, written or paused; --apply does it):")
    expect(out).toContain(`sch_rest "sync: Sabbath rest starts" (session ses_a, {"type":"at","at":"2026-11-06T21:35:00Z"})`)
    expect(out).toContain(`  prompt (`)
    expect(out).toContain(`-> ${prompts}/sch_rest.md`)
    expect(out).toContain(`  in /work/app: monitor({"command":"gh pr view 1 --json state","cwd":"/work/app","intervalSeconds":900,`)
    expect(out).toContain('"repeat":"change","baseline":"<23 chars>"')
    expect(out).toContain("  then: pause sch_watch")
    expect(out).toContain("  skip: cron (0 9 * * 1, UTC) has no wake equivalent")
    expect(await Bun.file(join(prompts, "sch_rest.md")).exists()).toBe(false)
  })

  test("render says when there is nothing to move; the flags parse", () => {
    expect(render([], false)).toBe("No active schedules.")
    expect(parseArgs(["--apply", "--rows", "r.json"], { HOME: "/h" })).toEqual({ apply: true, db: "/h/.local/share/opencode/opencode.db", rows: "r.json", prompts: "/h/.local/state/opencode-wake/schedules" })
    expect(() => parseArgs(["--nope"], {})).toThrow("unknown flag --nope")
  })
})
