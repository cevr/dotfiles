// @reads all
// @reads-reason computed read at mods/rex/process/simulators.ts: return yield* png(new Uint8Array(yield* Effect.tryPromise({ try: () => readFile(file), catch: (
// The simctl adapter's own parts: the booted simulators read from
// `simctl list devices booted -j`, the ssh call (batch mode, a plain host,
// never an option), the Mac-side screenshot command, and the pane's words
// on a host that is not a Mac with no Mac named.
import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { Simulators } from "../service.ts"
import * as ProcessSimulators from "./simulators.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

const LISTED = `{
  "devices" : {
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0" : [
      { "lastUsedAt" : "2026-11-15T04:47:00Z", "udid" : "9969DB1A-0F0C-4F3E-B27B-055B1AA83E35", "isAvailable" : true, "state" : "Booted", "name" : "verify-hymnal" },
      { "udid" : "26FBDB9E-3FFE-432A-8FE0-ABB32A69B378", "isAvailable" : true, "state" : "Shutdown", "name" : "old" }
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-1" : []
  }
}`

const at = (platform: string, host: string) => Simulators.use((simulators) => Effect.succeed(simulators.at(host))).pipe(Effect.provide(ProcessSimulators.layer({ platform })))

describe("the simctl adapter", () => {
  effectTest(
    "reads the booted simulators with their OS, and nothing from output it does not know",
    Effect.sync(() => {
      expect(ProcessSimulators.bootedIn(LISTED)).toEqual(
        Option.some([{ udid: "9969DB1A-0F0C-4F3E-B27B-055B1AA83E35", name: "verify-hymnal", os: "iOS 27.0", used: "2026-11-15T04:47:00Z" }]),
      )
      expect(ProcessSimulators.bootedIn("Permission denied")).toEqual(Option.none())
    }),
    hangGuard("local-fixture"),
  )

  effectTest(
    "reaches a Mac with ssh in batch mode, a plain host only, and screenshots there into a temporary file it removes",
    Effect.sync(() => {
      expect(ProcessSimulators.sshArgs("cvr@mac", "true")).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "cvr@mac", "true"])
      for (const good of ["cvr@cristians-macbook-pro", "mac.local", "100.92.183.50"]) expect(ProcessSimulators.isHost(good)).toBe(true)
      for (const bad of ["-oProxyCommand=true", "cvr@-x", "a b", "", "mac;true"]) expect(ProcessSimulators.isHost(bad)).toBe(false)
      const command = ProcessSimulators.remoteShot("9969DB1A-0F0C-4F3E-B27B-055B1AA83E35")
      expect(command).toContain(`xcrun simctl io 9969DB1A-0F0C-4F3E-B27B-055B1AA83E35 screenshot --type=png "$f"`)
      expect(command).toStartWith("f=$(mktemp -t rex-show-sim) && ")
      expect(command).toContain(`cat "$f"; rm -f "$f"; exit $s`)
    }),
    hangGuard("local-fixture"),
  )

  effectTest(
    "off a Mac with no Mac named says where simulators run and how to reach one; a host that is not one is refused",
    Effect.gen(function* () {
      const nowhere = yield* at("linux", "")
      expect((yield* Effect.flip(nowhere.booted)).message).toBe(ProcessSimulators.NOT_A_MAC)
      expect((yield* Effect.flip(nowhere.screenshot("9969DB1A-0F0C-4F3E-B27B-055B1AA83E35"))).message).toBe(ProcessSimulators.NOT_A_MAC)
      const bad = yield* at("linux", "-oProxyCommand=true")
      expect((yield* Effect.flip(bad.booted)).message).toBe("REX_SHOW_SIM_HOST is not an ssh host: -oProxyCommand=true")
    }),
    hangGuard("local-fixture"),
  )
})
