// @reads all
// @reads-reason computed read at mods/digest/http/page.test.ts: expect(readFileSync(join(PAGE, STAMP), "utf8")).toBe(`${sourceHash(PAGE)}\n${distHash(PAGE)}\n`
// The committed page is the page's source, built: dist/ carries the hash of everything the build read and of what it
// wrote, and every file its index.html loads is in it. A source change that was not rebuilt (`bun run build` in
// page/) and committed fails here, before a stale page ships; so does a hand edit of dist/ (the build's output no
// longer matches its stamp). Not caught: a build whose output was swapped together with a stamp rewritten by hand.
import { describe, expect, test } from "bun:test"
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { distHash, HERE as PAGE, sourceHash, STAMP, stampOf } from "../page/stamp.ts"
import { scratch } from "../../../tests/scratch.ts"

describe("the built page", () => {
  test("dist/ is built from the page's source as it is now, and is what that build wrote", () => {
    expect(readFileSync(join(PAGE, STAMP), "utf8")).toBe(`${sourceHash(PAGE)}\n${distHash(PAGE)}\n`)
  })

  test("a hand edit of a built file no longer matches the stamp", () => {
    using held = scratch("digest-page-")
    cpSync(PAGE, held.path, { recursive: true, filter: (path) => !path.includes("node_modules") })
    const html = join(held.path, "dist", "index.html")
    expect(readFileSync(join(held.path, STAMP), "utf8")).toBe(stampOf(held.path))
    writeFileSync(html, `${readFileSync(html, "utf8")}<!-- edited by hand -->`)
    expect(readFileSync(join(held.path, STAMP), "utf8")).not.toBe(stampOf(held.path))
  })

  test("every script and stylesheet index.html loads is in dist/assets, and nothing loads from elsewhere", () => {
    const html = readFileSync(join(PAGE, "dist", "index.html"), "utf8")
    const loads = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? "")
    expect(loads.length).toBeGreaterThanOrEqual(2)
    for (const path of loads) {
      expect(path).toMatch(/^\.\/assets\/[\w.-]+$/)
      expect(existsSync(join(PAGE, "dist", path))).toBe(true)
    }
  })
})
