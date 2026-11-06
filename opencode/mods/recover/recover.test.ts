import { describe, expect, test } from "bun:test"
import { movedNotice, recoverTarget, type Switch } from "./recover.ts"

const at = (directory: string) => ({ directory })
const moved = (to: string, from?: string): Switch => ({ location: at(to), ...(from ? { previous: { location: at(from) } } : {}) })

describe("recoverTarget", () => {
  test("goes back to where the session was made when its only move's target is gone", () => {
    expect(recoverTarget("/rift", [moved("/rift", "/repo")], () => true)).toEqual(at("/repo"))
  })

  test("takes the newest location that still exists", () => {
    // Made in /repo, moved to /a, then /b, then /c (gone); /b is gone too.
    const switches = [moved("/c", "/b"), moved("/b", "/a"), moved("/a", "/repo")]
    const exists = (directory: string) => directory === "/a" || directory === "/repo"
    expect(recoverTarget("/c", switches, exists)).toEqual(at("/a"))
  })

  test("offers a switch's destination before the place it left", () => {
    // The session sits in /gone, an older record than the newest switch to /b.
    const switches = [moved("/b", "/a")]
    expect(recoverTarget("/gone", switches, () => true)).toEqual(at("/b"))
  })

  test("never answers the missing directory itself", () => {
    expect(recoverTarget("/rift", [moved("/rift")], () => true)).toBeUndefined()
  })

  test("answers nothing when no earlier location exists", () => {
    expect(recoverTarget("/c", [moved("/c", "/b"), moved("/b", "/a")], () => false)).toBeUndefined()
    expect(recoverTarget("/c", [], () => true)).toBeUndefined()
  })

  test("keeps the workspace a location names", () => {
    const switches: ReadonlyArray<Switch> = [{ location: at("/rift"), previous: { location: { directory: "/repo", workspaceID: "wrk_1" } } }]
    expect(recoverTarget("/rift", switches, () => true)).toEqual({ directory: "/repo", workspaceID: "wrk_1" })
  })
})

test("movedNotice names where the session went and what is gone", () => {
  const home = (directory: string) => directory.replace(/^\/home\/me/, "~")
  expect(movedNotice(at("/home/me/repo"), "/home/me/.rifts/x", home)).toBe("Moved to ~/repo: ~/.rifts/x no longer exists")
})
