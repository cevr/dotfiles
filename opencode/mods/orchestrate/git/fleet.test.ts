import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { moves, repositoryAt, repositoryOf, targetOf } from "./fleet.ts"

const D1 = "1".repeat(40)
const D2 = "2".repeat(40)
const F1 = "a".repeat(40)
const F2 = "b".repeat(40)

describe("the verified target an accepted batch records", () => {
  test("an ssh and an https URL of one repository are the same repository", () => {
    expect(repositoryOf("git@github.com:cevr/dotfiles.git")).toBe("github.com/cevr/dotfiles")
    expect(repositoryOf("https://github.com/cevr/dotfiles")).toBe("github.com/cevr/dotfiles")
    expect(repositoryOf("ssh://git@github.com/cevr/dotfiles.git/")).toBe("github.com/cevr/dotfiles")
    expect(repositoryOf("https://github.com/cevr/opencode.git")).not.toBe(repositoryOf("git@github.com:cevr/dotfiles.git"))
  })

  test("the verifier's checkout is of the dotfiles, the fork or neither, by its origin", () => {
    const origins = { dotfiles: Option.some("git@github.com:cevr/dotfiles.git"), fork: Option.some("https://github.com/cevr/opencode") }
    expect(repositoryAt(Option.some("https://github.com/cevr/dotfiles"), origins)).toBe("dotfiles")
    expect(repositoryAt(Option.some("git@github.com:cevr/opencode.git"), origins)).toBe("fork")
    expect(repositoryAt(Option.some("git@github.com:bite/app.git"), origins)).toBe("neither")
    expect(repositoryAt(Option.none(), origins)).toBe("neither")
    expect(repositoryAt(Option.some("git@github.com:cevr/opencode.git"), { ...origins, fork: Option.none() })).toBe("neither")
  })

  test("a dotfiles batch pairs its commit with the fork's checkout; a fork batch with the dotfiles already verified", () => {
    const current = Option.some({ dotfiles: D1, fork: F1, batch: "batch-1" })
    expect(targetOf({ repository: "dotfiles", head: D2, batch: "batch-2", fork: F2, current, main: D1 })).toEqual({ dotfiles: D2, fork: F2, batch: "batch-2" })
    expect(targetOf({ repository: "fork", head: F2, batch: "batch-3", fork: F1, current, main: D2 })).toEqual({ dotfiles: D1, fork: F2, batch: "batch-3" })
    expect(targetOf({ repository: "fork", head: F2, batch: "batch-3", fork: F1, current: Option.none(), main: D2 })).toEqual({ dotfiles: D2, fork: F2, batch: "batch-3" })
  })

  test("recording the commits already recorded moves nothing", () => {
    const current = Option.some({ dotfiles: D1, fork: F1, batch: "batch-1" })
    expect(moves({ dotfiles: D1, fork: F1, batch: "batch-9" }, current)).toBe(false)
    expect(moves({ dotfiles: D2, fork: F1, batch: "batch-9" }, current)).toBe(true)
    expect(moves({ dotfiles: D1, fork: F1, batch: "batch-9" }, Option.none())).toBe(true)
  })
})
