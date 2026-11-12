// Public UI seam: real OpenCode with the skills plugin, a project whose
// `review` skill exists in both tiers, and a scripted model. The `$` popup is
// read off the frame; what each `$` token attached, off the model requests.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

/** The frame's lines, without the composer's rails and padding. */
const lines = (frame: string): ReadonlyArray<string> => frame.split("\n").map((line) => line.replaceAll("┃", "").replace(/\s+/g, " ").trim())

/** How many times `needle` occurs in `haystack`. */
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

// The popup needs the fork's plugin autocomplete (`ui.autocomplete`); a fork without it draws none.
const fork = process.env.OPENCODE_DEV
const hooked = fork !== undefined && readFileSync(join(fork, "packages/plugin/src/tui/context.ts"), "utf8").includes("readonly autocomplete: (source: AutocompleteSource)")
if (!fork) console.warn("tests/skills.test.ts: skipped. Set OPENCODE_DEV to the fork.")
else if (!hooked) console.warn(`tests/skills.test.ts: skipped. ${fork} has no plugin autocomplete (ui.autocomplete).`)
describe.skipIf(!hooked)("$ skills", () => {
  const kept = keptScratch(hooked, "skills-")
  test("the popup lists both tiers, a pick sends the local skill, the qualified token the global one, and $5 or a code span nothing", kept.test(async () => {
    const out = kept.dir("skills-")
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/skills.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const read = (name: string) => readFileSync(join(out, `skills-${name}`), "utf8")
    const timeout = join(out, "skills-timeout.txt")
    expect({ code, tail: code === 0 ? "" : `${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}` }).toEqual({ code: 0, tail: "" })
    expect(stdout).toMatch(/screenshot: .*skills-popup\.png/)

    // `$` lists every skill; the project's review holds `$review`, the user's is reachable as `$review:global`.
    const popup = lines(read("popup.txt"))
    expect(popup).toContain("$review Review this project's change local")
    expect(popup).toContain("$review:global Review any change, the user's way global · shadowed")
    expect(popup).toContain("$deploy Ship to production global")
    expect(popup).toContain("$")

    // `$rev` narrows the popup to the two reviews, local first.
    const filtered = lines(read("filtered.txt"))
    const first = filtered.indexOf("$review Review this project's change local")
    expect(filtered.slice(first, first + 3)).toEqual(["$review Review this project's change local", "$review:global Review any change, the user's way global · shadowed", "$rev"])
    expect(filtered.some((line) => line.includes("Ship to production"))).toBe(false)

    // Enter inserts the token and closes the popup.
    const picked = lines(read("picked.txt"))
    expect(picked).toContain("$review")
    expect(picked.some((line) => line.includes("shadowed"))).toBe(false)

    // The transcript shows the attachment under each turn that named a skill.
    const done = lines(read("done.txt"))
    expect(done.slice(done.indexOf("$review check the diff"), done.indexOf("$review check the diff") + 2)).toEqual(["$review check the diff", "skill review"])
    expect(done.slice(done.indexOf("now $review:global please"), done.indexOf("now $review:global please") + 2)).toEqual(["now $review:global please", "skill review"])
    expect(done[done.indexOf("it costs $5 and `$deploy` stays text") + 1]).toBe("")

    // The model's requests: the picked token carries the local body, the qualified token the global one,
    // and the third turn adds no skill (no `$5` skill, no `$deploy` inside backticks).
    const requests: ReadonlyArray<string> = JSON.parse(read("requests.json"))
    expect(requests).toHaveLength(3)
    const [one = "", two = "", three = ""] = requests
    expect([count(one, "LOCAL-REVIEW-BODY"), count(one, "GLOBAL-REVIEW-BODY")]).toEqual([1, 0])
    expect([count(two, "LOCAL-REVIEW-BODY"), count(two, "GLOBAL-REVIEW-BODY")]).toEqual([1, 1])
    expect(count(two, "<skill_content")).toBe(count(one, "<skill_content") + 1)
    expect(count(three, "<skill_content")).toBe(count(two, "<skill_content"))
    expect(requests.some((request) => request.includes("DEPLOY-BODY"))).toBe(false)
  }), 240_000)
})
