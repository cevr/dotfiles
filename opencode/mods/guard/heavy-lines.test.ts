// Law (c) of host-admit-queue: which shell lines the guard admits as heavy.
// - plain read lines (git, sed, grep, cat, pgrep loops, `L=…;` assignments,
//   pipes, redirects, process substitution) are never heavy;
// - a line holding a real heavy run anywhere (after `cd`, in a loop body,
//   behind a redirect) stays heavy;
// - a run that is itself `host-admit check run --width N -- …` is not
//   wrapped again: it asks admission at its own declared width.
// The real lines of the incident (queue-lines.ts) and a property
// over generated lines.
import { describe, expect, test } from "bun:test"
import { parseShell } from "./command-line.ts"
import { QUEUE_LINES } from "./queue-lines.ts"
import { DEFAULT_HEAVY, heavyCommand } from "./heavy.ts"

const heavy = (line: string) => heavyCommand(parseShell(line), DEFAULT_HEAVY)

describe("the incident's lines", () => {
  test("each is classified as the law says", () => {
    const got = Object.fromEntries(Object.entries(QUEUE_LINES).map(([name, line]) => [name, heavy(line)]))
    expect(got).toEqual({
      selfMatchingWait: false, declaredScript: false, declaredTimeout: false, declaredInside: false,
      declaredAfterAssignment: false, plainSedEdit: false,
      plainGit: false, plainSed: false, plainCat: false, plainProbe: false, heavyTest: true, heavyCd: true,
    })
  })
})

/** mulberry32: each run replays its seed. */
const random = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
const pick = <A>(next: () => number, items: readonly [A, ...ReadonlyArray<A>]): A => items[Math.floor(next() * items.length)] ?? items[0]

const LIGHT = [
  "git status --short", "git -C /tmp/repo log --oneline -5", "sed -n '1,40p' notes.md", "grep -nE 'a|b' file.log",
  "cat /proc/loadavg", "pgrep -f 'sh /tmp/x/both.sh'", "cut -c1-200", "echo done", "ps -u $(id -u) -o pid=,args=",
  "diff <(grep -E x a.log) <(grep -E x b.log)", "L=/tmp/units/CHECK", "wc -l $L/iter.log", "sleep 15", "head -20 out.txt",
] as const
const HEAVY = ["bun test --parallel=4 mods/guard", "bun run typecheck", "tsc -p .", "go test ./...", "cargo build"] as const
const JOIN = ["; ", " && ", " | ", " || "] as const
const FORMS = [
  (a: string, b: string, join: string) => `${a}${join}${b}`,
  (a: string, b: string) => `while ${a}; do ${b}; done`,
  (a: string, b: string) => `if ${a}; then ${b}; fi`,
  (a: string, b: string) => `${a} > /tmp/out.log 2>&1; ${b}`,
  (a: string, b: string) => `cd /tmp/lane && ${a}; ${b}`,
] as const

const lineOf = (next: () => number, parts: ReadonlyArray<string>) =>
  parts.reduce((line, part) => pick(next, FORMS)(line, part, pick(next, JOIN)))

describe("generated lines", () => {
  test("light parts never make a heavy line; one heavy part anywhere does; inside host-admit check run it is admitted already", () => {
    const next = random(20261126)
    const seen = { light: 0, heavy: 0, admitted: 0 }
    for (let round = 0; round < 3000; round++) {
      const parts = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(next, LIGHT))
      const light = lineOf(next, parts)
      expect({ light, heavy: heavy(light) }).toEqual({ light, heavy: false })
      seen.light++
      const at = Math.floor(next() * (parts.length + 1))
      const task = pick(next, HEAVY)
      const withHeavy = lineOf(next, [...parts.slice(0, at), task, ...parts.slice(at)])
      expect({ withHeavy, heavy: heavy(withHeavy) }).toEqual({ withHeavy, heavy: true })
      seen.heavy++
      const admitted = lineOf(next, [...parts.slice(0, at), `host-admit check run --class check --width ${1 + Math.floor(next() * 8)} -- timeout 30m ${task}`, ...parts.slice(at)])
      expect({ admitted, heavy: heavy(admitted) }).toEqual({ admitted, heavy: false })
      seen.admitted++
    }
    expect(seen).toEqual({ light: 3000, heavy: 3000, admitted: 3000 })
  })
})
