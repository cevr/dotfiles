// dotfiles/tui-clock-only (lint/tui-clock.ts), through the oxlint binary the
// gate runs, with the repository's own override (.oxlintrc.json): a planted
// `setInterval` in mods/prime/tui/ and a planted `Date.now()` in
// cmd/escape/setup.ts are refused, as is each form the rule's header lists;
// the clock's own calls, a property named like a timer, a dated `new Date(x)`
// and a test file are left alone, and a file outside the seam's folders is
// never read by the rule.
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const CODE = "dotfiles(tui-clock-only)"

/** Each planted file, by its path under the tree, and how many diagnostics it must get. */
const FILES: ReadonlyArray<readonly [string, string, number]> = [
  ["mods/prime/tui/planted.tsx", "export const stop = setInterval(() => {}, 1000)", 1],
  ["cmd/escape/setup.ts", "export const at = Date.now()", 1],
  [
    "mods/prime/opencode/forms.ts",
    [
      "export const a = setTimeout(() => {}, 1)",
      "clearTimeout(a)",
      "globalThis.setInterval(() => {}, 1)",
      "export const b = performance.now()",
      "await Bun.sleep(1)",
      "export const c = Bun.nanoseconds()",
      "export const d = process.hrtime()",
      "export const e = new Date()",
      "setImmediate(() => {})",
    ].join("\n"),
    9,
  ],
  [
    "mods/escape/quiet.ts",
    [
      'import * as TuiClock from "@dotfiles/decider/tui-clock"',
      "export const a = TuiClock.now()",
      "TuiClock.once(5, () => {})",
      "export const b = { setTimeout: 1 }.setTimeout",
      "export const c = new Date(0)",
    ].join("\n"),
    0,
  ],
  ["cmd/prime/clock.test.ts", "export const a = Date.now()", 0],
  ["mods/other/free.ts", "export const a = Date.now()", 0],
]

test("tui-clock-only refuses a raw timer or clock in the seam's folders and nothing else", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lint-tui-clock-"))
  try {
    for (const [file, code] of FILES) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      writeFileSync(path.join(dir, file), `${code}\n`)
    }
    const repo = JSON.parse(readFileSync(path.join(ROOT, ".oxlintrc.json"), "utf8")) as {
      readonly overrides: ReadonlyArray<{ readonly files: ReadonlyArray<string>; readonly rules: Record<string, unknown> }>
    }
    const overrides = repo.overrides.filter((each) => "dotfiles/tui-clock-only" in each.rules)
    const config = path.join(dir, "oxlintrc.json")
    writeFileSync(config, JSON.stringify({ jsPlugins: [path.join(ROOT, "lint/test-env.ts")], overrides }))
    const child = Bun.spawn([path.join(ROOT, "node_modules/.bin/oxlint"), "-c", config, "--format", "json", dir], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
    const report = JSON.parse(out) as { readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly filename: string }> }
    const found = new Map<string, number>()
    for (const diagnostic of report.diagnostics.filter((each) => each.code === CODE)) {
      const file = path.relative(dir, path.resolve(dir, diagnostic.filename))
      found.set(file, (found.get(file) ?? 0) + 1)
    }
    expect(FILES.map(([file]) => [file, found.get(file) ?? 0])).toEqual(FILES.map(([file, , errors]) => [file, errors]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
