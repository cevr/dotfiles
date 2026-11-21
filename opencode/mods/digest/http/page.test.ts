// The committed page is the page's source, built: dist/ carries the hash of everything the build read, and every file
// its index.html loads is in it. A source change that was not rebuilt (`bun run build` in page/) and committed fails
// here, before a stale page ships.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { HERE as PAGE, sourceHash, STAMP } from "../page/stamp.ts"

describe("the built page", () => {
  test("dist/ is built from the page's source as it is now", () => {
    expect(readFileSync(join(PAGE, STAMP), "utf8").trim()).toBe(sourceHash(PAGE))
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
