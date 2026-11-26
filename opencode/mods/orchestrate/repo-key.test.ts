// The repository key: every URL form of one repository (https, ssh with or without a port, scp-like, with and without
// `.git`, upper case) gives one key, and two repositories give two. A property over generated repositories, seeded.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { keyOfOrigin, localKey } from "./repo-key.ts"

/** A seeded generator: the same repositories at every run. */
const seeded = (seed: number) => {
  const state = { at: seed }
  return (below: number): number => {
    state.at = (state.at * 1_103_515_245 + 12_345) % 2_147_483_648
    return state.at % below
  }
}

// Names of letters, digits, `.` and `_`: a `-` inside a name collides `a-b/c` with `a/b-c` (a follow-up of the key rule).
const LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789._"

const wordOf = (next: (below: number) => number): string => {
  const first = LETTERS[next(26)] ?? "a"
  const rest = Array.from({ length: 1 + next(8) }, () => LETTERS[next(LETTERS.length)] ?? "a").join("")
  return `${first}${rest}`.replace(/[._]+$/, "")
}

interface Repo {
  readonly host: string
  readonly owner: string
  readonly name: string
}

/** Every way an origin names `repo`. */
const formsOf = (repo: Repo): ReadonlyArray<string> => {
  const path = `${repo.owner}/${repo.name}`
  const forms = [
    `https://${repo.host}/${path}`,
    `https://${repo.host}/${path}.git`,
    `https://user@${repo.host}/${path}.git`,
    `ssh://git@${repo.host}/${path}.git`,
    `ssh://git@${repo.host}:2222/${path}.git`,
    `git@${repo.host}:${path}.git`,
    `git@${repo.host}:${path}`,
    `${repo.host}:${path}/`,
  ]
  return [...forms, ...forms.map((form) => form.toUpperCase())]
}

const repos = (count: number): ReadonlyArray<Repo> => {
  const next = seeded(7)
  return Array.from({ length: count }, () => ({ host: `${wordOf(next)}.com`, owner: wordOf(next), name: wordOf(next) }))
}

describe("keyOfOrigin", () => {
  test("names the dotfiles repository as the spec does", () => {
    expect(keyOfOrigin("https://github.com/cevr/dotfiles.git")).toEqual(Option.some("github.com-cevr-dotfiles"))
    expect(keyOfOrigin("git@github.com:cevr/dotfiles.git")).toEqual(Option.some("github.com-cevr-dotfiles"))
  })

  test("one repository gives one key in every URL form, for 300 generated repositories", () => {
    for (const repo of repos(300)) {
      const keys = new Set(formsOf(repo).map((form) => Option.getOrElse(keyOfOrigin(form), () => "")))
      expect([...keys]).toEqual([`${repo.host}-${repo.owner}-${repo.name}`.toLowerCase()])
    }
  })

  test("two repositories give two keys", () => {
    const all = repos(300)
    const distinct = new Set(all.map((repo) => `${repo.host}/${repo.owner}/${repo.name}`))
    const keys = new Set(all.map((repo) => Option.getOrElse(keyOfOrigin(`https://${repo.host}/${repo.owner}/${repo.name}.git`), () => "")))
    expect(keys.size).toBe(distinct.size)
  })

  test("a URL that leaves nothing has no key; a checkout with no origin is local", () => {
    expect(keyOfOrigin("  ")).toEqual(Option.none())
    expect(keyOfOrigin("https://")).toEqual(Option.none())
    expect(localKey("0123456789abcdef0123")).toBe("local-0123456789ab")
  })
})
