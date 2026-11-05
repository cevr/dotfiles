import { describe, expect, test } from "bun:test"
import { tokens } from "./mention.ts"

const ids = (text: string) => tokens(text).map((token) => (token.tier ? `${token.id}:${token.tier}` : token.id))

describe("$ tokens", () => {
  test("at the start of the text or after whitespace, with offsets and the text as written", () => {
    expect(tokens("$review this\nthen\t$deploy")).toEqual([
      { id: "review", start: 0, end: 7, text: "$review" },
      { id: "deploy", start: 18, end: 25, text: "$deploy" },
    ])
  })

  test("never inside a word", () => {
    expect(ids("a$review cost$deploy x$y")).toEqual([])
  })

  test("never a price or anything starting with a digit", () => {
    expect(ids("it costs $5, or $5.99, or $10k")).toEqual([])
  })

  test("a lone or doubled trigger names nothing", () => {
    expect(ids("$ and $$ and $-x")).toEqual([])
  })

  test("never in an inline code span, of one backtick or more", () => {
    expect(ids("run `$review` and ``echo $HOME`` then $deploy")).toEqual(["deploy"])
  })

  test("an unmatched backtick is literal, so a token after it counts", () => {
    expect(ids("a ` then $review")).toEqual(["review"])
  })

  test("never in a fenced block, and the text after the fence counts again", () => {
    expect(ids("```sh\necho $review\n```\n~~~\n$x\n~~~\n$deploy")).toEqual(["deploy"])
  })

  test("an unclosed fence runs to the end", () => {
    expect(ids("$a\n```\n$b")).toEqual(["a"])
  })

  test("a tier suffix, and punctuation that ends the sentence", () => {
    expect(tokens("use $review:global, then $review:local.")).toEqual([
      { id: "review", tier: "global", start: 4, end: 18, text: "$review:global" },
      { id: "review", tier: "local", start: 25, end: 38, text: "$review:local" },
    ])
    expect(ids("load $code-review. then $a.b?")).toEqual(["code-review", "a.b"])
  })

  test("a colon that is not a tier stays outside the token", () => {
    expect(tokens("$review: now")).toEqual([{ id: "review", start: 0, end: 7, text: "$review" }])
    expect(ids("$review:globally")).toEqual(["review"])
  })
})
