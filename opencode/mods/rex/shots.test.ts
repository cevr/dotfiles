// When a page is shot again, how two shots are told apart, the viewport a
// shot fills the pane with, and the page's name in the header.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { due, fingerprint, nameOf, viewport } from "./shots.ts"

describe("a page's shots", () => {
  const taken = Option.some({ seq: 3, sized: "82x35", at: 10_000, print: 7 })

  test("are due at first, when what is shown or the pane's size changed, and once the interval passed", () => {
    expect(due(Option.none(), 3, "82x35", 0, 5_000)).toBe(true)
    expect(due(taken, 3, "82x35", 14_999, 5_000)).toBe(false)
    expect(due(taken, 3, "82x35", 15_000, 5_000)).toBe(true)
    expect(due(taken, 4, "82x35", 10_001, 5_000)).toBe(true)
    expect(due(taken, 3, "80x35", 10_001, 5_000)).toBe(true)
  })

  test("print the same for the same bytes, and differently for one byte changed", () => {
    expect(fingerprint(new Uint8Array([1, 2, 3]))).toBe(fingerprint(new Uint8Array([1, 2, 3])))
    expect(fingerprint(new Uint8Array([1, 2, 3]))).not.toBe(fingerprint(new Uint8Array([1, 2, 4])))
    expect(fingerprint(new Uint8Array())).toBe(0x811c9dc5)
  })

  test("are as tall as the pane's room in pixels for their width", () => {
    expect(viewport(1200, { cols: 82, rows: 33 }, { width: 12, height: 38 })).toEqual({ width: 1200, height: 1529 })
    expect(viewport(1000, { cols: 100, rows: 25 }, { width: 1, height: 2 })).toEqual({ width: 1000, height: 500 })
  })

  test("name the page by its host and path", () => {
    expect(nameOf(new URL("http://localhost:4321/"))).toBe("localhost:4321")
    expect(nameOf(new URL("https://sideshow.dev/posts/12/?x=1"))).toBe("sideshow.dev/posts/12")
  })
})
