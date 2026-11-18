import { describe, expect, test } from "bun:test"
import { releaseFlags } from "./release-flags.ts"

describe("releaseFlags", () => {
  test("a run that names no flag gets full_codemode off, as the owner's build has it", () => {
    expect(releaseFlags({ PATH: "/bin" })).toEqual({ PATH: "/bin", OPENCODE_FLAGS: "-full_codemode" })
    expect(releaseFlags({ OPENCODE_FLAGS: "" }).OPENCODE_FLAGS).toBe("-full_codemode")
  })

  test("the caller's other flags stay, and all still loses full_codemode", () => {
    expect(releaseFlags({ OPENCODE_FLAGS: "automations,-media_blob" }).OPENCODE_FLAGS).toBe(
      "automations,-media_blob,-full_codemode",
    )
    expect(releaseFlags({ OPENCODE_FLAGS: "all" }).OPENCODE_FLAGS).toBe("all,-full_codemode")
  })

  test("a caller that names full_codemode, on or off, keeps its word", () => {
    expect(releaseFlags({ OPENCODE_FLAGS: "full_codemode" }).OPENCODE_FLAGS).toBe("full_codemode")
    expect(releaseFlags({ OPENCODE_FLAGS: " -full_codemode " }).OPENCODE_FLAGS).toBe(" -full_codemode ")
  })
})
