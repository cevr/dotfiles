// A notice's body read back through its envelope, and drawn by the notice fold: the property over bodies that name
// tags (round-1 finding M1). The host writes the body raw between its tags (upstream e51247f626's
// background-result.ts, and the old tag per kind before it), so a body may hold any tag text: mid-line (a grep of a
// file that names `<shell>`), inside quotes and attributes, a closing tag alone on a line (a shell that prints it), and
// a whole notice it quotes. The reader gives back exactly the body, and the fold draws its lines and no tag of its own.
import { describe, expect, test } from "bun:test"
import { envelopes, type Form, KINDS, render, TAG } from "@dotfiles/opencode-subagents/envelope"
import { type NoticeLine, noticeGroup, noticeLines } from "./notice.ts"
import type { SyntheticMessage } from "./session.ts"

/** A seeded generator (a 32-bit LCG): the same runs on every machine, and a failure names its seed. */
const random = (seed: number) => {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <A>(items: ReadonlyArray<A>): A => items[int(items.length)]!
  return { int, pick }
}
type Random = ReturnType<typeof random>

const NAMES = [TAG, ...KINDS]
const FORMS: ReadonlyArray<Form> = ["background-result", "kind"]
/** The tag an envelope of `form` and `kind` is written with. */
const nameOf = (form: Form, kind: string) => {
  if (form === "background-result") return TAG
  return kind
}

/** An opening tag as the host writes one, with attributes that may hold quotes' worth of tag text. */
const opening = (r: Random, name: string) => {
  let kind = ""
  if (name === TAG) kind = ` kind="${r.pick(KINDS)}"`
  return `<${name}${kind} id="sh_${r.int(99)}" state="${r.pick(["completed", "error", "cancelled"])}"${r.pick(["", ' command="echo <shell> > out"', ' description="say </background-result>"'])}>`
}

/** A line that names tags anywhere but at its start, or names none. */
const midLine = (r: Random): string =>
  r.pick([
    () => "plain words",
    () => "",
    () => "  indented",
    () => `x ${opening(r, r.pick(NAMES))} y`,
    () => `a </${r.pick(NAMES)}> b`,
    () => "mods/guard/launcher.ts:2:// stands in for the shell. OpenCode spawns `<shell> -c <command>`; for a",
    () => "docs.md:53: user-role messages containing `<background-result>` XML.",
    () => `You will receive a <background-result kind="subagent"> message when it goes idle`,
    () => `attr="${opening(r, r.pick(NAMES))}" and '</${r.pick(NAMES)}>'`,
    () => `<<${r.pick(NAMES)}> <> </>`,
  ])()

/**
 * A body of `form`'s tag `own`: lines that name tags mid-line; at a line start, tags of other names, and whole
 * notices of its own name it quotes; and, after the last quoted notice, closing tags of its own name alone on a line.
 */
const body = (r: Random, own: string): string => {
  const lines: string[] = []
  let strays = false
  for (let n = r.int(8); n > 0; n--) {
    const choice = r.int(10)
    const other = r.pick(NAMES.filter((name) => name !== own))
    if (choice < 5) lines.push(midLine(r))
    else if (choice === 5) lines.push(opening(r, other))
    else if (choice === 6) lines.push(`</${other}>`)
    else if (choice === 7 && !strays) lines.push(opening(r, own), midLine(r), `</${own}>`)
    else if (choice === 8) {
      lines.push(`</${own}>`)
      strays = true
    } else lines.push(midLine(r))
  }
  return lines.join("\n")
}

const notice = (text: string, source: "shell" | "subagent"): SyntheticMessage => ({
  type: "synthetic",
  id: "n1",
  text,
  description: "check",
  metadata: { source, state: "error" },
  time: { created: 0 },
})

const words = (lines: ReadonlyArray<NoticeLine>) => lines.map((line) => line.runs.map((run) => run.text).join(""))

/** The lines the fold hangs under a notice's header at All: the body's, trimmed as a call's output is. */
const foldOf = (said: string) => {
  const trimmed = said.trim()
  const [first = "", ...rest] = trimmed.split("\n").map((line) => line.trimEnd())
  return [first, ...rest]
}

describe("a notice's body through its envelope (property, finding M1)", () => {
  test("for both forms and every kind, a body that names tags reads back exactly, and the fold draws only its lines", () => {
    let checked = 0
    for (let seed = 1; seed <= 400; seed++) {
      const r = random(seed)
      for (const form of FORMS)
        for (const kind of KINDS) {
          const said = body(r, nameOf(form, kind))
          const attributes = { id: `sh_${seed}`, state: "error", command: "rg -n shell mods/guard" }
          const text = r.pick(["", "The following shell command was executed by the user:\n"]) + render(form, kind, attributes, said)
          const [read] = envelopes(text)
          expect({ seed, form, kind, body: read?.body, end: read?.end }).toEqual({ seed, form, kind, body: said, end: text.length })
          if (kind === "shell" || kind === "subagent") {
            const group = noticeGroup([notice(text, kind)], "n1")!
            expect({ seed, form, kind, fold: words(noticeLines(group, "all")) }).toEqual({ seed, form, kind, fold: foldOf(said) })
          }
          checked++
        }
    }
    expect(checked).toBe(400 * FORMS.length * KINDS.length)
  })

  test("the verifier's probe: a shell output naming its own tag mid-line folds to its lines, in both forms", () => {
    const output = "mods/guard/launcher.ts:2:// stands in for the shell. OpenCode spawns `<shell> -c <command>`; for a"
    const docs = "docs.md:53: user-role messages containing `<background-result>` XML."
    const cases = [
      [`<background-result kind="shell" id="sh_1" state="completed" command="rg -n shell mods/guard">\nsh_1 · exited 0 · 0.1 s\n${output}\n</background-result>`, output],
      [`<shell id="sh_1" state="completed" command="rg -n shell mods/guard">\nsh_1 · exited 0 · 0.1 s\n${output}\n</shell>`, output],
      [`<background-result kind="shell" id="sh_1" state="completed" command="rg -n XML docs">\nsh_1 · exited 0 · 0.1 s\n${docs}\n</background-result>`, docs],
    ] as const
    for (const [text, line] of cases) {
      const group = noticeGroup([notice(text, "shell")], "n1")!
      expect(words(noticeLines(group, "details"))).toEqual(["sh_1 · exited 0 · 0.1 s", line])
    }
  })

  test("a body that prints the closing tag alone on a line keeps it: the host's own closing tag is the last one", () => {
    const text = '<background-result kind="shell" id="sh_1" state="completed" command="cat notice.xml">\nsh_1 · exited 0 · 0.1 s\n</background-result>\ntail\n</background-result>'
    expect(envelopes(text).map((each) => each.body)).toEqual(["sh_1 · exited 0 · 0.1 s\n</background-result>\ntail"])
  })

  test("two notices in one text read as two: an opening tag after the first's close starts the next", () => {
    const one = render("background-result", "shell", { id: "sh_1" }, "a")
    const two = render("kind", "subagent", { sessionID: "ses_1" }, "b")
    const again = render("background-result", "shell", { id: "sh_2" }, "c")
    expect(envelopes(`${one}\n${two}\n${again}`).map((each) => [each.kind, each.body])).toEqual([
      ["shell", "a"],
      ["subagent", "b"],
      ["shell", "c"],
    ])
  })
})
