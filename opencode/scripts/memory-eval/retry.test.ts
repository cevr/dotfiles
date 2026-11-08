import { describe, expect, test } from "bun:test"
import { isRetryOf, retryFixed, wordsOf } from "./retry.ts"

const failed = (command: string) => ({ command, failed: true })
const passed = (command: string) => ({ command, failed: false })

describe("the gotcha trigger's detector", () => {
  test("fires on each scenario's gotcha: a failure, then the same command run another way, passing", () => {
    expect(retryFixed([failed("npm test src/lib/slug.test.ts")], passed("TEST_ENV=unit npm test src/lib/slug.test.ts"))).toBe(true)
    expect(retryFixed([failed("cd opencode && OPENCODE_DEV=~/Developer/opencode bun run gate")], passed("cd opencode && OPENCODE_DEV=$HOME/Developer/opencode bun run gate"))).toBe(true)
    expect(retryFixed([failed("pytest tests/test_invoice.py")], passed("uv run pytest tests/test_invoice.py"))).toBe(true)
    expect(retryFixed([failed("go test ./..."), passed("ls")], passed("go test -short ./..."))).toBe(true)
  })

  test("stays quiet when the same command passes again: that was a code fix", () => {
    expect(retryFixed([failed("bun test"), passed("git diff")], passed("bun test"))).toBe(false)
  })

  test("stays quiet for an unrelated success, a failure out of the window, and a failure already fixed", () => {
    expect(retryFixed([failed("bun run lint")], passed("git status"))).toBe(false)
    expect(retryFixed([failed("go test ./..."), passed("a"), passed("b"), passed("c")], passed("go test -short ./..."))).toBe(false)
    expect(retryFixed([failed("go test ./..."), passed("go test -short ./...")], passed("go test -short -v ./..."))).toBe(false)
    expect(retryFixed([failed("go test ./...")], failed("go test -short ./..."))).toBe(false)
  })

  test("reads commands by their words, without cd steps, separators or redirections", () => {
    expect([...wordsOf("cd opencode && bun run gate 2>&1 | tail -5")]).toEqual(["bun", "run", "gate", "tail", "-5"])
    expect(isRetryOf("git status", "git log")).toBe(false)
    expect(isRetryOf("pytest", "uv run pytest")).toBe(true)
  })
})
