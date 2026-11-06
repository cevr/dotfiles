// How the pr tool names the requests and reviewers it is given.
import { describe, expect, test } from "bun:test"
import { BadInput, refOf, repoOfUrl, reviewersFor } from "./pr.ts"

describe("a named request", () => {
  test("a URL and owner/name#123 name their own repository", () => {
    expect(refOf("https://github.com/biteinc/maitred/pull/412/files", "cevr/dotfiles")).toEqual({ repo: "biteinc/maitred", number: 412 })
    expect(refOf("biteinc/maitred#412", undefined)).toEqual({ repo: "biteinc/maitred", number: 412 })
  })

  test("a bare number is in the session's repository", () => {
    expect(refOf(7, "cevr/dotfiles")).toEqual({ repo: "cevr/dotfiles", number: 7 })
    expect(refOf("#7", "cevr/dotfiles")).toEqual({ repo: "cevr/dotfiles", number: 7 })
  })

  test("a bare number outside a checkout, or no request at all, is refused with what to give", () => {
    expect(refOf(7, undefined)).toEqual(new BadInput({ reason: "#7 needs a repository: the session is in no GitHub checkout; give owner/name#7" }))
    expect(refOf("main", "cevr/dotfiles")).toBeInstanceOf(BadInput)
  })

  test("a request's URL names its repository", () => expect(repoOfUrl("https://github.com/biteinc/maitred/pull/9")).toBe("biteinc/maitred"))
})

describe("the reviewers create asks", () => {
  const configured = { biteinc: ["andrewgoupil", "antwandaher", "narminmolina"], "biteinc/solo": ["alice"] }

  test("default asks the owner's configured logins, and a repository's own entry wins", () => {
    expect(reviewersFor("biteinc/maitred", undefined, configured)).toEqual(["andrewgoupil", "antwandaher", "narminmolina"])
    expect(reviewersFor("biteinc/solo", "default", configured)).toEqual(["alice"])
    expect(reviewersFor("cevr/dotfiles", "default", configured)).toEqual([])
  })

  test("none asks no one; given logins are asked as given", () => {
    expect(reviewersFor("biteinc/maitred", "none", configured)).toEqual([])
    expect(reviewersFor("biteinc/maitred", ["bob"], configured)).toEqual(["bob"])
  })
})
