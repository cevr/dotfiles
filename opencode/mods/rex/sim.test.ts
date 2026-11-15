// Which booted simulator is mirrored, what the pane says when none is, how
// a runtime reads, and which udids may go to the Mac's shell.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Choice, choose, type Device, isUdid, osOf, whyNone } from "./sim.ts"

const device = (name: string, used: string, udid = "26FBDB9E-3FFE-432A-8FE0-ABB32A69B378"): Device => ({ udid, name, os: "iOS 27.0", used })
const older = device("verify-heartseed", "2026-11-15T01:26:08Z", "26FBDB9E-3FFE-432A-8FE0-ABB32A69B378")
const newer = device("verify-hymnal", "2026-11-15T04:47:00Z", "9969DB1A-0F0C-4F3E-B27B-055B1AA83E35")

describe("the mirrored simulator", () => {
  test("is the one named, by name in any case or by udid, else the one used last", () => {
    expect(choose([older, newer], Option.none())).toEqual(Choice.Chosen({ device: newer }))
    expect(choose([newer, older], Option.none())).toEqual(Choice.Chosen({ device: newer }))
    expect(choose([older, newer], Option.some("VERIFY-HEARTSEED"))).toEqual(Choice.Chosen({ device: older }))
    expect(choose([older, newer], Option.some("9969db1a-0f0c-4f3e-b27b-055b1aa83e35"))).toEqual(Choice.Chosen({ device: newer }))
  })

  test("is none when none is booted, or the one named is not, and the pane says which are", () => {
    expect(whyNone(choose([], Option.none()))).toEqual(Option.some("no iOS simulator is booted: boot one in Xcode or Simulator (rex-show never boots one)"))
    expect(whyNone(choose([older, newer], Option.some("iPad")))).toEqual(Option.some("no booted simulator named iPad; booted: verify-heartseed, verify-hymnal"))
    expect(whyNone(choose([], Option.some("iPad")))).toEqual(Option.some("no booted simulator named iPad; booted: none"))
    expect(whyNone(choose([older], Option.none()))).toEqual(Option.none())
  })

  test("reads its runtime as people say it", () => {
    expect(osOf("com.apple.CoreSimulator.SimRuntime.iOS-27-0")).toBe("iOS 27.0")
    expect(osOf("com.apple.CoreSimulator.SimRuntime.watchOS-11-2-1")).toBe("watchOS 11.2.1")
    expect(osOf("something else")).toBe("something else")
  })

  test("goes to the Mac's shell only as a udid", () => {
    expect(isUdid(older.udid)).toBe(true)
    for (const bad of ["booted", "x; rm -rf /nonexistent/loop-probe-x", "26FBDB9E-3FFE-432A-8FE0-ABB32A69B378 && true", ""]) expect(isUdid(bad)).toBe(false)
  })
})
