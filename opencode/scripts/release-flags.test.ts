import { describe, expect, test } from "bun:test"
import { releaseFlags } from "./release-flags.ts"

describe("releaseFlags", () => {
  test("a run that names no flag gets full_codemode off, as the owner's build has it", () => {
    expect(releaseFlags("")).toBe("-full_codemode")
    expect(releaseFlags("  ")).toBe("-full_codemode")
  })

  test("the caller's other flags stay, and all still loses full_codemode", () => {
    expect(releaseFlags("automations,-media_blob")).toBe("automations,-media_blob,-full_codemode")
    expect(releaseFlags("all")).toBe("all,-full_codemode")
  })

  test("a caller that names full_codemode, on or off, keeps its word", () => {
    expect(releaseFlags("full_codemode")).toBe("full_codemode")
    expect(releaseFlags(" -full_codemode ")).toBe(" -full_codemode ")
  })
})
// @reads-indirect scripts/**
