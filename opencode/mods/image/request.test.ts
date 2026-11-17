import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { absolute, check, FALLBACK_MODEL, media, numbered, type Request, resolve, slug } from "./request.ts"

const context = { directory: "/work/deck", outputs: "/tmp/opencode/images/ses_1", id: "a1b2", models: ["gpt-6.1-sol", "gpt-6-sol"] }

const request = (overrides: Partial<Request>): Request => ({
  prompt: "a red cube",
  images: [],
  path: "/out/cube.png",
  size: "auto",
  format: "png",
  models: ["gpt-6-sol"],
  paid: Option.none(),
  ...overrides,
})

const paid = { model: "flare" as const, quality: Option.none(), background: Option.none(), n: Option.none(), mask: Option.none() }

const problem = (checked: Result.Result<Request, { readonly code: string; readonly message: string }>) =>
  Result.match(checked, { onFailure: (failed) => `${failed.code} ${failed.message}`, onSuccess: () => "ok" })

describe("resolve", () => {
  test("fills the defaults: png, auto, a slugged path in the outputs folder, the subscription's models, no paid options", () => {
    expect(resolve({ prompt: "A Red Cube, on glass!" }, context)).toEqual({
      prompt: "A Red Cube, on glass!",
      images: [],
      path: "/tmp/opencode/images/ses_1/a-red-cube-on-glass-a1b2.png",
      size: "auto",
      format: "png",
      models: ["gpt-6.1-sol", "gpt-6-sol"],
      paid: Option.none(),
    })
  })

  test("resolves relative image, output and mask paths against the session's directory and keeps absolute ones", () => {
    const resolved = resolve(
      { prompt: "p", images: ["refs/a.png", "/abs/b.jpg", "./c.webp"], path: "out/d.webp", format: "webp", paid: { model: "sunburst", mask: "m.png", n: 2 } },
      context,
    )
    expect(resolved.images).toEqual(["/work/deck/refs/a.png", "/abs/b.jpg", "/work/deck/c.webp"])
    expect(resolved.path).toBe("/work/deck/out/d.webp")
    expect(Option.map(resolved.paid, (p) => [p.model, Option.getOrNull(p.mask), Option.getOrNull(p.n)])).toEqual(
      Option.some(["sunburst", "/work/deck/m.png", 2]),
    )
  })

  test("asks the fallback model when OpenCode lists no subscription model", () => {
    expect(resolve({ prompt: "p" }, { ...context, models: [] }).models).toEqual([FALLBACK_MODEL])
  })
})

describe("check", () => {
  test("a plain subscription request passes", () => expect(problem(check(request({})))).toBe("ok"))

  test.each([
    [request({ prompt: "  " }), "INVALID_INPUT Missing prompt: say what to create or change."],
    [request({ images: Array.from({ length: 17 }, (_, i) => `/r/${i}.png`) }), "INVALID_INPUT At most 16 images, got 17."],
    [request({ images: ["/r/a.png", "/r/bad.txt"] }), "INVALID_INPUT Unsupported image type: /r/bad.txt (use png/jpg/jpeg/webp/gif)."],
    [request({ size: "big" }), "INVALID_INPUT Invalid size: big (use auto or WIDTHxHEIGHT, e.g. 1536x1024)."],
    [request({ size: "0x1024" }), "INVALID_INPUT Invalid size: 0x1024 (use auto or WIDTHxHEIGHT, e.g. 1536x1024)."],
    [request({ models: [] }), "INVALID_INPUT No subscription model to ask."],
    [request({ paid: Option.some({ ...paid, n: Option.some(0) }) }), "INVALID_INPUT paid.n must be 1 to 10."],
    [request({ paid: Option.some({ ...paid, n: Option.some(11) }) }), "INVALID_INPUT paid.n must be 1 to 10."],
    [request({ paid: Option.some({ ...paid, mask: Option.some("/m.png") }) }), "INVALID_INPUT paid.mask needs a source image: pass the image to edit in images."],
    [
      request({ images: ["/s.png"], paid: Option.some({ ...paid, mask: Option.some("/m.jpg") }) }),
      "INVALID_INPUT paid.mask must be a PNG whose transparent areas mark where to edit.",
    ],
  ])("refuses a broken rule: %#", (broken, expected) => expect(problem(check(broken))).toBe(expected))

  test("a paid request needs no subscription model, and takes 1 to 10 images and a PNG mask over sources", () => {
    expect(problem(check(request({ models: [], images: ["/s.png"], paid: Option.some({ ...paid, n: Option.some(10), mask: Option.some("/m.PNG") }) })))).toBe(
      "ok",
    )
  })
})

describe("names", () => {
  test("slug keeps lowercase letters and digits joined by -, at most 60 characters, image when none", () => {
    expect(slug("Hello, World 2026!")).toBe("hello-world-2026")
    expect(slug("¡¿…")).toBe("image")
    expect(slug("x".repeat(80))).toHaveLength(60)
  })

  test("numbered puts the index before the extension, or at the end when the name has none", () => {
    expect(numbered("/out/cube.png", 2)).toBe("/out/cube-2.png")
    expect(numbered("/out.dir/cube", 1)).toBe("/out.dir/cube-1")
  })

  test("media reads the extension, case aside", () => {
    expect(media("/a/B.JPG")).toEqual(Option.some("image/jpeg"))
    expect(media("/a.png/file")).toEqual(Option.none())
    expect(media("/a/b.gif")).toEqual(Option.some("image/gif"))
  })

  test("absolute keeps an absolute path and joins a relative one", () => {
    expect(absolute("/w/", "./x.png")).toBe("/w/x.png")
    expect(absolute("/w", "/x.png")).toBe("/x.png")
  })
})
