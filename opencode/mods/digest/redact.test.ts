// What the digest keeps of a pasted secret. Every secret here is invented: random-looking text made for this test,
// no key of any account.
import { describe, expect, test } from "bun:test"
import { REDACTED, redact } from "./redact.ts"

const caught: ReadonlyArray<readonly [string, string]> = [
  ["a bearer token", "use Bearer Zq9fakeTok3nZq9fakeTok3nZq9 for it"],
  ["an sk- key", "the key is sk-test1nvent3dKeyAbCdEfGh0123"],
  ["a Stripe-style key", "sk_live_1nvent3dKeyAbCdEfGh0123"],
  ["a ghp_ token", "ghp_1nvent3dTokenAbCdEfGhIjKlMn0123456"],
  ["a fine-grained GitHub token", "github_pat_11AAAAAAA0inventedXyZinvented"],
  ["a Slack token", "xoxb-0000000000-invented-tokenXyZ"],
  ["an AWS access key id", "AKIAINVENTED0EXAMPLE"],
  ["a Google API key", "AIzaInvented0Key0That0Is0Thirty0Five0xy"],
  ["a GitLab token", "glpat-Invented0Token0AbCdEfGh"],
  ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJpbnZlbnRlZCJ9.c2lnbmF0dXJlLWludmVudGVk"],
  ["a long random run of no known form", "here: Q7mZ2xK9pL4vN8rT1wY6bH3cJ5dF0gS2aE7u"],
  ["a private key block", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktaW52ZW50ZWQ=\n-----END OPENSSH PRIVATE KEY-----"],
  ["a private key block cut before its end", "-----BEGIN RSA PRIVATE KEY-----\nMIIEinvented"],
]

describe("redact", () => {
  for (const [name, text] of caught)
    test(`replaces ${name}`, () => {
      const kept = redact(text)
      expect(kept).toContain(REDACTED)
      // No run of the secret past its first few characters is left.
      const secret = text.match(/[A-Za-z0-9_+=-]{16,}/g) ?? []
      for (const run of secret.filter((each) => !/^(BEGIN|END)$/.test(each))) expect(kept.includes(run.slice(4))).toBe(false)
    })

  test("keeps the words around a secret", () => {
    expect(redact("the key is sk-test1nvent3dKeyAbCdEfGh0123, rotate it")).toBe(`the key is ${REDACTED}, rotate it`)
  })

  test("leaves ordinary answers whole: words, paths, a commit hash, a long identifier", () => {
    for (const text of [
      "Keep it",
      "Cut it, but keep the old export one more release",
      "see mods/digest/page/ui/answer.tsx line 40",
      "revert 3f9c1e2a7b4d5f60718293a4b5c6d7e8f9012345",
      "rename it to digestAnswerControlForQueueItems",
      "port 8080 (note: 3000 is the dev default)",
    ])
      expect(redact(text)).toBe(text)
  })

  test("misses what it says it misses: a short password and lowercase hex", () => {
    expect(redact("the password is hunter2")).toBe("the password is hunter2")
    expect(redact("0123456789abcdef0123456789abcdef01234567")).toBe("0123456789abcdef0123456789abcdef01234567")
  })
})
