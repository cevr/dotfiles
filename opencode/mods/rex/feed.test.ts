// Which post a followed session shows, how it is drawn, its tally, and the
// session the `sideshow` CLI falls back to for a folder.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Draw, drawOf, latest, tallyFor, byCwd } from "./feed.ts"
import type { Post } from "./service.ts"

const post = (id: string, at: string, surfaces: Post["surfaces"] = [], version = 1): Post => ({ id, title: `post ${id}`, version, updatedAt: at, surfaces })
const BASE = "http://localhost:8228"

describe("a followed session", () => {
  test("shows the post updated last, the later listed of a tie, and none when there are none", () => {
    expect(latest([])).toEqual(Option.none())
    expect(latest([post("a", "2026-11-15T10:00:00Z"), post("b", "2026-11-15T09:00:00Z")]).pipe(Option.map((shown) => shown.id))).toEqual(Option.some("a"))
    expect(latest([post("a", "2026-11-15T10:00:00Z"), post("b", "2026-11-15T10:00:00Z")]).pipe(Option.map((shown) => shown.id))).toEqual(Option.some("b"))
  })

  test("draws a post by its first surface: an image's asset, Markdown's text, a page kind's own page at its version, anything else flattened", () => {
    expect(drawOf(post("p", "t", [{ kind: "image", index: 0, assetId: "a1" }, { kind: "html", index: 1 }]), BASE)).toEqual(Draw.Asset({ id: "a1", url: `${BASE}/a/a1` }))
    expect(drawOf(post("p", "t", [{ kind: "markdown", index: 0, markdown: "# hi" }]), BASE)).toEqual(Draw.Markdown({ text: "# hi" }))
    for (const kind of ["html", "mermaid", "diff", "terminal", "code"]) {
      expect(drawOf(post("p", "t", [{ kind, index: 0 }], 3), BASE)).toEqual(Draw.Shoot({ url: `${BASE}/p/p?surface=0&ver=3` }))
    }
    for (const surfaces of [[{ kind: "json", index: 0 }], [{ kind: "trace", index: 0 }], []]) {
      expect(drawOf(post("p", "t", surfaces), BASE)).toEqual(Draw.Flatten({ post: "p" }))
    }
  })

  test("counts its posts in the tally, with the latest's title", () => {
    expect(tallyFor(0, Option.none())).toEqual({ msg: "no posts yet", state: "working" })
    expect(tallyFor(1, Option.some(post("a", "t")))).toEqual({ msg: "1 post · post a", state: "working" })
    expect(tallyFor(4, Option.some(post("d", "t")))).toEqual({ msg: "4 posts · post d", state: "working" })
  })

  test("falls back to the session last active in the folder, as the CLI does", () => {
    const rows = [
      { id: "old", cwd: "/w", lastActiveAt: "2026-11-15T09:00:00Z" },
      { id: "new", cwd: "/w", lastActiveAt: "2026-11-15T10:00:00Z" },
      { id: "other", cwd: "/x", lastActiveAt: "2026-11-15T11:00:00Z" },
    ]
    expect(byCwd(rows, "/w")).toEqual(Option.some("new"))
    expect(byCwd(rows, "/y")).toEqual(Option.none())
  })
})
