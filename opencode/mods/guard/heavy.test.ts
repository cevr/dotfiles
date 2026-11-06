// Which commands are heavy, under the default patterns and a configured list.
import { describe, expect, test } from "bun:test"
import { DEFAULT_HEAVY, isHeavy } from "./heavy.ts"

const heavy = (line: string) => isHeavy(line, DEFAULT_HEAVY)

describe("a heavy command", () => {
  test("a test run, a typecheck or a gate, with its arguments", () => {
    for (const line of [
      "bun test",
      "bun test mods/guard --timeout 30000",
      "bun run gate",
      "OPENCODE_DEV=/x bun run gate --all",
      "bun run accept:affected",
      "bun run test:integration",
      "tsc --noEmit -p .",
      "./node_modules/.bin/tsc -b",
      "tsgolint",
      "vitest run",
      "jest --ci",
      "pnpm test",
      "npx -y vitest run",
      "bunx --bun tsc",
      "pnpm exec jest",
      "timeout 600 bun test",
      "timeout -k 5 600 bun test",
      "playwright test e2e",
      "turbo run build",
    ])
      expect([line, heavy(line)]).toEqual([line, true])
  })

  test("anywhere in a line: after cd, in a chain, a pipe, a subshell, sh -c or eval", () => {
    for (const line of [
      "cd opencode && bun run gate > /tmp/gate.log 2>&1; echo $?",
      "uptime; bun test 2>&1 | tail -40",
      "(cd app && vitest run)",
      "bash -c 'bun test'",
      "eval bun test",
      "nice -n 5 bun test",
      "env -u ANTHROPIC_BASE_URL bun run accept",
    ])
      expect([line, heavy(line)]).toEqual([line, true])
  })
})

describe("not a heavy command", () => {
  test("a light command, or a heavy one's words as data", () => {
    for (const line of [
      "ls -la",
      "bun install",
      "bun run lint",
      "bun run dev",
      "bun scripts/agents.ts --check",
      "bun run tester",
      "git commit -m 'run bun test'",
      "echo bun test",
      "grep -rn tsc .",
      "cat <<EOF\nbun test\nEOF",
      "npx prettier --write .",
    ])
      expect([line, heavy(line)]).toEqual([line, false])
  })
})

test("the patterns are the configured list, not the defaults", () => {
  expect(isHeavy("make check", ["make check"])).toBe(true)
  expect(isHeavy("bun test", ["make check"])).toBe(false)
  expect(isHeavy("bun test", [])).toBe(false)
  expect(isHeavy("bun test", [" "])).toBe(false)
})
