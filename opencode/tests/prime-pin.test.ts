// Runs scenarios/prime-pin.ts with the Prime look against an OpenCode checkout
// and asserts the ask pinned over the transcript: none at the bottom; scrolled
// up, the transcript's first row is the prompt the top of the view answers,
// drawn as the prompt draws, on one line; a click on it scrolls that prompt to
// the top, where it shows itself. It needs OPENCODE_DEV, a fork with the
// session.transcript.overlay slot.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-pin.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
type Span = { text: string; fg: ReadonlyArray<number>; bg: ReadonlyArray<number>; attributes?: number }
type Saved = { text: ReadonlyArray<string>; lines: ReadonlyArray<{ spans: ReadonlyArray<Span> }> }
const names = ["pin-bottom", "pin-answer-2", "pin-answer-1", "pin-revealed"] as const
const frames = new Map<(typeof names)[number], Saved>()
const frame = (name: (typeof names)[number]): Saved => frames.get(name) ?? { text: [], lines: [] }

// The transcript's first row, under the one-row top bar.
const FIRST = 1
const ASK_ONE = "List the first batch."
const ASK_TWO_START = "Now list the second batch"

/** The rail and the prompt's text on a row: each span's text, colour and attributes, the blank padding left out. */
const look = (saved: Saved, y: number) =>
  (saved.lines[y]?.spans ?? [])
    .filter((span) => span.text.trim() !== "")
    .map((span) => ({ text: span.text, fg: span.fg, bold: ((span.attributes ?? 0) & 1) === 1 }))

describe.skipIf(!fork)("the ask pinned over the transcript in the Prime look (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-pin-"))
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-pin.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    for (const name of names)
      frames.set(name, {
        text: readFileSync(join(out, `${name}.txt`), "utf8").split("\n"),
        lines: JSON.parse(readFileSync(join(out, `${name}.json`), "utf8")).lines,
      })
  }, 300_000)

  test("at the bottom nothing is pinned: the first row is the answer", () => {
    expect(frame("pin-bottom").text[FIRST]).toMatch(/^ {2}- two item \d\d$/)
    expect(frame("pin-bottom").text.join("\n")).not.toContain("┃ Now list")
  })

  test("scrolled into answer 2, the first row is ask 2 on one line, cut with an ellipsis at the width", () => {
    const shown = frame("pin-answer-2").text
    expect(shown[FIRST]).toBe(
      " ┃ Now list the second batch, and keep going well past the width of this terminal so the pinned li…",
    )
    expect(Array.from(shown[FIRST] ?? "").length).toBeLessThanOrEqual(100)
    expect(shown[FIRST + 1]).toMatch(/^ {2}- two item \d\d$/)
    // Ask 2's own rows are out of view: only the pin names it.
    expect(shown.filter((line) => line.includes(ASK_TWO_START))).toHaveLength(1)
  })

  test("scrolled further, into answer 1, the first row is ask 1", () => {
    const shown = frame("pin-answer-1").text
    expect(shown[FIRST]).toBe(` ┃ ${ASK_ONE}`)
    expect(shown[FIRST + 1]).toMatch(/^ {2}- one item \d\d$/)
    // Ask 2 is in view further down, yet the top answers ask 1: the pin follows the top, not the newest ask.
    expect(shown.findIndex((line) => line.includes(ASK_TWO_START))).toBeGreaterThan(FIRST + 1)
  })

  test("the pin draws as the prompt does: the rail and bold text in the prompt's colour", () => {
    const pinned = look(frame("pin-answer-1"), FIRST)
    expect(pinned.map((span) => span.text)).toEqual(["┃", ASK_ONE])
    expect(pinned).toEqual(look(frame("pin-revealed"), FIRST))
    expect(pinned[1]?.bold).toBe(true)
  })

  test("a click on the pin scrolls ask 1 to the top, in place, its answer under it", () => {
    const shown = frame("pin-revealed").text
    expect(shown[FIRST]).toBe(` ┃ ${ASK_ONE}`)
    expect(shown.slice(FIRST + 1).filter((line) => line.trim() !== "")[0]).toBe("  - one item 01")
    // It is the prompt's own row, not the pin: the pin fills its row opaque, the transcript does not.
    const fill = (name: (typeof names)[number]) =>
      frame(name).lines[FIRST]?.spans.find((span) => span.text === ASK_ONE)?.bg[3]
    expect(fill("pin-answer-1")).toBe(255)
    expect(fill("pin-revealed")).toBe(0)
  })
})
