// The heavy-check footer's rules, over every host from 1 to 256 cores with 0
// to 64 heavy agents working (every case, not a sample), and over generated
// prompts for the footer's one-footer rule.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { FOOTER_MARK, footerFor, footerOf, type HeavyRole, shareOf, withFooter } from "./heavy.ts"

const CORES = Array.from({ length: 256 }, (_, index) => index + 1)
const WORKING = Array.from({ length: 65 }, (_, index) => index)

/** A seeded generator, so a failing prompt is found again. */
const generator = (seed: number) => {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
  const pieces = ["", " ", "\n", "\n\n", "x", "go on", "Spec: /tmp/a/spec.md", "(folds: a/M1)", "Heavy", "share", "orchestrate", "  \t", "é", "`bun test`"]
  const prompt = () => Array.from({ length: Math.floor(next() * 12) }, () => pieces[Math.floor(next() * pieces.length)]).join("")
  const pick = <A>(items: ReadonlyArray<A>) => items[Math.floor(next() * items.length)]!
  return { prompt, pick }
}

const count = (text: string, part: string) => text.split(part).length - 1

describe("shareOf", () => {
  test("is max(4, floor(cores / (working + 2))) capped at the host's cores: an integer, at least min(4, cores), never above cores", () => {
    for (const cores of CORES)
      for (const working of WORKING) {
        const share = shareOf(cores, working)
        expect(share).toBe(Math.min(cores, Math.max(4, Math.floor(cores / (working + 2)))))
        expect(Number.isInteger(share)).toBe(true)
        expect(share).toBeGreaterThanOrEqual(Math.min(4, cores))
        expect(share).toBeLessThanOrEqual(cores)
      }
  })

  test("never rises as more heavy agents work", () => {
    for (const cores of CORES)
      for (const working of WORKING.slice(1)) expect(shareOf(cores, working)).toBeLessThanOrEqual(shareOf(cores, working - 1))
  })

  test("splits the host between this agent, the batch lane and the agents working: the shares add up to no more than the cores", () => {
    for (const cores of CORES)
      for (const working of WORKING) {
        if (cores < 4 * (working + 2)) continue
        expect(shareOf(cores, working) * (working + 2)).toBeLessThanOrEqual(cores)
      }
  })

  test("counts the agents working: the same cores give a smaller share as they grow", () => {
    expect(shareOf(12, 0)).toBe(6)
    expect(shareOf(12, 1)).toBe(4)
    expect(shareOf(64, 0)).toBe(32)
    expect(shareOf(64, 6)).toBe(8)
    expect(shareOf(2, 0)).toBe(2)
  })
})

describe("footerOf", () => {
  const ROLES: ReadonlyArray<HeavyRole> = ["implementor", "verifier"]

  test("names the share, the cores and each runner's flag at the share", () => {
    for (const role of ROLES)
      for (const [share, cores] of [
        [4, 12],
        [6, 12],
        [32, 64],
        [1, 1],
      ] as const) {
        const footer = footerOf(role, share, cores)
        expect(footer).toStartWith(`${FOOTER_MARK} ${share} of this host's ${cores} cores`)
        expect(footer).toContain(`\`bun test --parallel=${share}\``)
        expect(footer).toContain(`Go's \`-p ${share}\` with \`GOMAXPROCS=${share}\``)
        expect(footer).toContain(`Cargo's \`-j ${share}\``)
        expect(footer).toContain("never the full gate, the full e2e or an affected-acceptance run, because the batch runs them once")
        expect(count(footer, FOOTER_MARK)).toBe(1)
      }
  })

  test("an implementor's says in one sentence that it runs its spec's round gate only", () => {
    const sentence = footerOf("implementor", 6, 12).split("\n").find((line) => line.includes("round gate"))
    expect(sentence).toBe(
      "You run your spec's round gate only, never the full gate, the full e2e or an affected-acceptance run, because the batch runs them once on its merged head.",
    )
  })

  test("a verifier's says its share is the batch lane's, and that it reads the batch's gate and accept logs and reruns neither", () => {
    const footer = footerOf("verifier", 6, 12)
    expect(footer).toContain("6 of this host's 12 cores, the batch lane's share")
    expect(footer).toContain("you read the batch's gate and accept logs and rerun neither")
    expect(footer).not.toContain("round gate")
  })

  test("footerFor: a heavy role's footer at its share of the host; none for any other agent", () => {
    expect(footerFor("implementor", 12, 1)).toEqual(Option.some(footerOf("implementor", 4, 12)))
    expect(footerFor("verifier", 12, 0)).toEqual(Option.some(footerOf("verifier", 6, 12)))
    for (const agent of ["planner", "worker", "explore", "build", "general"]) expect(Option.isNone(footerFor(agent, 12, 0))).toBe(true)
  })
})

describe("withFooter", () => {
  const footers = CORES.slice(0, 16).flatMap((cores) => [footerOf("implementor", shareOf(cores, 0), cores), footerOf("verifier", shareOf(cores, 3), cores)])

  test("ends the prompt with the footer, after the prompt's own words", () => {
    expect(withFooter("go on", footers[0]!)).toBe(`go on\n\n${footers[0]}`)
    expect(withFooter("", footers[0]!)).toBe(footers[0]!)
  })

  test("is idempotent: applied to its own output with any footer, the prompt holds exactly one, the newest", () => {
    const { prompt, pick } = generator(1113)
    for (let index = 0; index < 2_000; index++) {
      const text = prompt()
      const first = pick(footers)
      const second = pick(footers)
      const once = withFooter(text, first)
      const twice = withFooter(once, second)
      expect(count(twice, FOOTER_MARK)).toBe(1)
      expect(twice).toEndWith(second)
      expect(twice).toBe(withFooter(text, second))
      expect(withFooter(twice, second)).toBe(twice)
    }
  })
})
