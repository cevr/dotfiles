import { describe, expect, test } from "bun:test"
import { env, spawnSync } from "bun"
import { scratch as scratchDir } from "../../../tests/scratch.ts"
import { launcher } from "./launcher.ts"

/** Writes `text` to an executable file at `path`, through the shell. */
const put = (path: string, text: string) => expect(spawnSync(["/bin/sh", "-c", 'printf "%s" "$1" > "$2" && chmod 755 "$2"', "sh", text, path]).exitCode).toBe(0)

describe("the opencode launcher", () => {
  test("runs the binary with the caller's arguments and without its Anthropic routing", () => {
    using held = scratchDir("launcher it's-")
    const binary = `${held.path}/opencode-fake`
    put(binary, '#!/bin/sh\necho "base=${ANTHROPIC_BASE_URL:-unset} insecure=${ANTHROPIC_INSECURE:-unset} home=$HOME args=$*"\n')
    const link = `${held.path}/opencode`
    put(link, launcher(binary, "/home/x/.local/state/opencode-prime/resident"))
    const run = spawnSync([link, "run", "hello"], { env: { ...env, HOME: "/home/x", ANTHROPIC_BASE_URL: "http://localhost:3456", ANTHROPIC_INSECURE: "1" } })
    expect(run.stdout.toString().trim()).toBe("base=unset insecure=unset home=/home/x args=run hello")
  })

  test("after a service start or restart, asks the service for its resident location; a failed start stops there", () => {
    using held = scratchDir("launcher-")
    const binary = `${held.path}/opencode-fake`
    put(binary, '#!/bin/sh\necho "ran $*"\n')
    const link = `${held.path}/opencode`
    put(link, launcher(binary, "/home/x/state/it's resident"))
    for (const verb of ["start", "restart"]) {
      const run = spawnSync([link, "service", verb], { env })
      expect([run.exitCode, run.stdout.toString().trim().split("\n")]).toEqual([0, [`ran service ${verb}`]])
    }
    // The boot's own output is dropped; what it was asked shows through a binary that prints to stderr.
    put(binary, '#!/bin/sh\necho "ran $*" >&2\n')
    const booted = spawnSync([link, "service", "restart"], { env })
    expect(booted.stderr.toString().trim().split("\n")).toEqual(["ran service restart", "ran api GET /api/location -H x-opencode-directory:%2Fhome%2Fx%2Fstate%2Fit%27s%20resident"])
    put(binary, '#!/bin/sh\necho "ran $*"\n[ "$1" = service ] && exit 3\nexit 0\n')
    const failed = spawnSync([link, "service", "start"], { env })
    expect([failed.exitCode, failed.stdout.toString().trim()]).toEqual([3, "ran service start"])
  })
})
