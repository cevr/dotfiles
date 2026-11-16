// The session the `sideshow` CLI falls back to for a folder.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { byCwd } from "./feed.ts"

describe("a followed session", () => {
  test("falls back to the session last active in the folder, as the CLI does", () => {
    const rows = [
      { id: "old", cwd: "/w", lastActiveAt: "2026-11-15T09:00:00Z" },
      { id: "new", cwd: "/w", lastActiveAt: "2026-11-15T10:00:00Z" },
      { id: "other", cwd: "/x", lastActiveAt: "2026-11-15T11:00:00Z" },
    ]
    expect(byCwd(rows, "/w")).toEqual(Option.some("new"))
    expect(byCwd(rows, "/y")).toEqual(Option.none())
  })
})
