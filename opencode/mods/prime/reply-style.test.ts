// Who is taught the chips at a session's first sighting: a new root session
// gets the section; a subagent, or a session older than the plugin, gets none.
// The decision over a store (sectionOf) is tested in memory/reply-style.test.ts.
import { describe, expect, test } from "bun:test"
import { firstSection } from "./reply-style.ts"

describe("firstSection", () => {
  test("a new root session gets the text; a subagent, or a session that already answered, gets none", () => {
    expect(firstSection({ child: false, answered: false }, "S")).toBe("S")
    expect(firstSection({ child: true, answered: false }, "S")).toBe("")
    expect(firstSection({ child: false, answered: true }, "S")).toBe("")
    expect(firstSection({ child: true, answered: true }, "S")).toBe("")
  })
})
