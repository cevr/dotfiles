import { describe, expect, test } from "bun:test"
import { classify, cutNote, cutText, isPdf, missingMessage, repoOf, size, textOf } from "./fetch.ts"

describe("classify", () => {
  // The built-in's messages, as the 7-day call pull recorded them.
  test("a 404 or 410 is Missing with its status", () => {
    expect(classify("StatusCode: non 2xx status code (404 GET https://raw.githubusercontent.com/anomalyco/rift/main/README.md)", "https://raw.githubusercontent.com/anomalyco/rift/main/README.md")).toEqual({
      _tag: "Missing",
      status: 404,
    })
    expect(classify("StatusCode: non 2xx status code (410 GET https://x.dev/a)", "https://x.dev/a")).toEqual({ _tag: "Missing", status: 410 })
  })

  test("a PDF content type is Pdf; another binary type is not, unless it comes from a .pdf path", () => {
    expect(classify("Unsupported fetched file content type: application/pdf", "https://unh.edu/mayer.pdf")).toEqual({ _tag: "Pdf" })
    expect(classify("Unsupported fetched file content type: application/octet-stream", "https://cdn.net/talk.PDF")).toEqual({ _tag: "Pdf" })
    expect(classify("Unsupported fetched file content type: application/octet-stream", "https://cdn.net/talk.zip")).toEqual({ _tag: "Other" })
    expect(classify("Unsupported fetched file content type: application/zip", "https://cdn.net/a.pdf")).toEqual({ _tag: "Other" })
  })

  test("a body over the limit is TooLarge", () => {
    expect(classify("Response too large (exceeds 5242880 byte limit)", "https://models.dev/api.json")).toEqual({ _tag: "TooLarge" })
  })

  test("anything else (a 406, a 500, a timeout, a transport error) is Other", () => {
    expect(classify("StatusCode: non 2xx status code (406 GET https://www.newscientist.com/a)", "https://www.newscientist.com/a")).toEqual({ _tag: "Other" })
    expect(classify("StatusCode: non 2xx status code (500 GET https://x.dev)", "https://x.dev")).toEqual({ _tag: "Other" })
    expect(classify("Request timed out", "https://www.npr.org/x")).toEqual({ _tag: "Other" })
    expect(classify("Transport error (GET https://developer.qubeyond.com)", "https://developer.qubeyond.com")).toEqual({ _tag: "Other" })
  })
})

describe("isPdf", () => {
  test("reads the content type, and a generic binary type by the path", () => {
    expect(isPdf("application/pdf", "https://a.dev/x")).toBe(true)
    expect(isPdf("application/x-pdf", "https://a.dev/x")).toBe(true)
    expect(isPdf("binary/octet-stream", "https://a.dev/x.pdf")).toBe(true)
    expect(isPdf("text/html", "https://a.dev/x.pdf")).toBe(false)
    expect(isPdf("application/octet-stream", "not a url")).toBe(false)
  })
})

describe("repoOf", () => {
  test("names the repository of a raw file or a blob, tree or raw page on GitHub", () => {
    expect(repoOf("https://raw.githubusercontent.com/rescript-lang/rescript-nodejs/master/src/Process.res")).toBe("rescript-lang/rescript-nodejs")
    expect(repoOf("https://github.com/effect-ts/effect/blob/main/README.md")).toBe("effect-ts/effect")
    expect(repoOf("https://github.com/effect-ts/effect.git/tree/main")).toBe("effect-ts/effect")
  })

  test("names none for any other page", () => {
    expect(repoOf("https://github.com/effect-ts/effect/issues/12")).toBeUndefined()
    expect(repoOf("https://github.com/effect-ts")).toBeUndefined()
    expect(repoOf("https://bun.com/docs/cli/test")).toBeUndefined()
    expect(repoOf("not a url")).toBeUndefined()
  })
})

describe("missingMessage", () => {
  test("on GitHub, names `okra repo fetch` with the repository", () => {
    expect(missingMessage("https://raw.githubusercontent.com/anomalyco/rift/main/README.md", 404)).toBe(
      "https://raw.githubusercontent.com/anomalyco/rift/main/README.md answered 404: no file at that path (a guessed path or branch). Stop guessing raw URLs: run `okra repo fetch anomalyco/rift` (it prints the local checkout's path), then read or grep the files there.",
    )
  })

  test("elsewhere, names websearch and `okra repo fetch <owner/repo>`", () => {
    expect(missingMessage("https://bun.com/docs/cli/test", 404)).toBe(
      "https://bun.com/docs/cli/test answered 404: no page at that URL (a guessed docs path). Find the real page with websearch, or read the project's source and docs locally with `okra repo fetch <owner/repo>`.",
    )
  })
})

describe("cutting", () => {
  test("size reads KB below a megabyte and MB above", () => {
    expect(size(512 * 1024)).toBe("512 KB")
    expect(size(6.2 * 1024 * 1024)).toBe("6.2 MB")
    expect(size(10)).toBe("1 KB")
  })

  test("the note says how much is shown, of how much, and how to read the rest", () => {
    expect(cutNote({ url: "https://models.dev/api.json", what: "the body", shownBytes: 512 * 1024, totalBytes: 6.2 * 1024 * 1024 })).toBe(
      "[webfetch: the body cut to the first 512 KB of 6.2 MB. For the rest, download it (`curl -sL 'https://models.dev/api.json' -o <file>`) and read the file in parts.]",
    )
    expect(cutNote({ url: "https://a.dev", what: "the body", shownBytes: 512 * 1024 })).toContain("of a larger body.")
  })

  test("cutText keeps text under the limit and cuts over it at a character boundary", () => {
    expect(cutText("hello", 10)).toEqual({ text: "hello", cut: false, bytes: 5 })
    // "é" is two bytes: a cut after 2 bytes would split the second one.
    expect(cutText("aéé", 4)).toEqual({ text: "aé", cut: true, bytes: 5 })
  })

  test("textOf keeps the readable text of cut HTML", () => {
    expect(textOf("<html><head><style>p{}</style><script>var x = 1</script></head><body><h1>Title</h1><p>One &amp; two&nbsp;&#8212; three</p><p>Cut mid-tag <a hr")).toBe(
      "Title\nOne & two — three\nCut mid-tag",
    )
    expect(textOf("<p>bad &#99999999; entity</p>")).toBe("bad &#99999999; entity")
  })
})
