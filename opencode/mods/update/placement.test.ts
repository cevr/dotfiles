import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { cgroupOf, describePlacement, Placement, placementOf, placeArgv, scopeName, SERVICE_WEIGHT } from "./placement.ts"

const MANAGER = "/user.slice/user-1000.slice/user@1000.service"
const HERDR = `${MANAGER}/app.slice/herdr-bite.service`

describe("the scope the service asks the user manager for", () => {
  test("is its own, opencode-service-<pid>.scope in app.slice, at CPUWeight=1000 and IOWeight=1000, with the service's process in it", () => {
    expect(SERVICE_WEIGHT).toBe(1000)
    expect(placeArgv(4242)).toEqual([
      "busctl", "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
      // The unit, its mode, and six properties, each a name, a D-Bus type and its value.
      "StartTransientUnit", "ssa(sv)a(sa(sv))", "opencode-service-4242.scope", "fail", "6",
      "Description", "s", "OpenCode service (dotfiles opencode/mods/update/placement.ts)",
      "PIDs", "au", "1", "4242",
      "Slice", "s", "app.slice",
      "CPUWeight", "t", "1000",
      "IOWeight", "t", "1000",
      "CollectMode", "s", "inactive-or-failed",
      // No auxiliary units.
      "0",
    ])
  })
})

describe("where a process runs, from its /proc cgroup text", () => {
  test("in its own scope it is placed", () => {
    expect(placementOf(4242, `0::${MANAGER}/app.slice/${scopeName(4242)}\n`)).toEqual(Placement.cases.Placed.make({ unit: "opencode-service-4242.scope" }))
  })

  test("under a user manager outside its scope it is unplaced, with where it runs and why", () => {
    expect(placementOf(4242, `0::${HERDR}\n`, "Access denied")).toEqual(Placement.cases.Unplaced.make({ cgroup: HERDR, cause: "Access denied" }))
    // Another process's scope is not this one's.
    expect(Placement.guards.Unplaced(placementOf(4242, `0::${MANAGER}/app.slice/${scopeName(7)}\n`))).toBe(true)
    // Started from an SSH login: the user manager takes it in from there too (probed on the workbox).
    expect(Placement.guards.Unplaced(placementOf(4242, "0::/user.slice/user-1000.slice/session-17378.scope\n"))).toBe(true)
  })

  test("with no user manager above it, or no cgroup v2 line, it is unmanaged", () => {
    expect(Placement.guards.Unmanaged(placementOf(4242, "0::/system.slice/opencode.service\n"))).toBe(true)
    expect(Placement.guards.Unmanaged(placementOf(4242, "1:name=systemd:/x\n"))).toBe(true)
    expect(cgroupOf("12:cpu:/a\n0::/b/c\n")).toEqual(Option.some("/b/c"))
  })

  test("each reads in the log", () => {
    expect(describePlacement(Placement.cases.Placed.make({ unit: "opencode-service-1.scope" }))).toBe("in opencode-service-1.scope at CPUWeight=1000")
    expect(describePlacement(Placement.cases.Unplaced.make({ cgroup: HERDR, cause: "boom" }))).toBe(`outside its scope, in ${HERDR}: boom`)
  })
})
