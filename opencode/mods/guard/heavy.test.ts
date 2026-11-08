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

  test("a Go or Rust build, test, vet or lint", () => {
    for (const line of [
      "go test -count=1 ./internal/sketch/check",
      "go build -trimpath ./p/...",
      "go vet ./...",
      "/usr/local/go/bin/go test ./...",
      "golangci-lint run",
      "cargo test --workspace",
      "cargo build --release",
      "cargo check",
      "cargo clippy -- -D warnings",
      "cargo nextest run",
      "cargo bench",
    ])
      expect([line, heavy(line)]).toEqual([line, true])
  })

  test("behind the launchers agents put in front, with their options", () => {
    for (const line of [
      "flock /tmp/verify-slot-0.lock env GOMEMLIMIT=6GiB GOMAXPROCS=4 GOCACHE=/tmp/v-gocache timeout 2400 sh -c 'go test -p 4 -count=1 ./internal/sketch/check; echo check=$?'",
      "setsid -f bun test",
      "nohup go test ./... > /tmp/t.log 2>&1 &",
      "env -i PATH=/usr/bin -u HOME -C /tmp GOFLAGS=-p=4 go test ./...",
      "env -- go vet ./...",
      "env -S 'bun test --bail'",
      "nice -n 19 cargo test",
      "nice -5 go build ./...",
      "nice --adjustment=10 tsc -b",
      "ionice -c3 go test ./...",
      "ionice -c 2 -n 7 cargo check",
      "stdbuf -oL -eL bun test",
      "stdbuf -o L go test -v ./...",
      "flock -w 600 /tmp/gate.lock bun run gate",
      "flock -x /tmp/gate.lock -c 'cd app && go test ./...'",
      "timeout 600 sh -c 'go test ./...'",
      "sudo -u ci time nice -n 5 setsid nohup timeout 600 go test ./...",
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
      "go run ./cmd/server",
      "go mod tidy",
      "go fmt ./...",
      "cargo run --bin tool",
      "cargo fmt",
      "make check",
      // A unit of the command's own runs outside the launcher, so it is not read through (heavy.ts).
      "systemd-run --user --wait --pipe -p MemoryMax=8G env GOMAXPROCS=4 go test ./...",
      "flock /tmp/verify-slot-0.lock systemd-run --user --scope go test ./...",
      "flock /tmp/gate.lock sh gate.sh",
      "flock -x /tmp/go.lock -c 'go mod download'",
      "env GOFLAGS=-p=4 go env",
      "nice -n 19 git gc",
      "setsid -f opencode serve",
      "stdbuf -oL tail -f /tmp/go-test.log",
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
