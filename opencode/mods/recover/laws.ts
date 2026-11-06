// What every implementation of the Directories contract owes, as a shared
// test suite. Each implementation's test beside it runs the suite over its
// Layer and a far side holding one directory and one file.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer } from "effect"
import { Directories } from "./service.ts"

/** The far side a law reads: an existing directory, a file, and a path that is neither. */
export interface Bench {
  readonly layer: Layer.Layer<Directories>
  readonly directory: string
  readonly file: string
  readonly missing: string
}

const exists = (bench: Bench, path: string) =>
  Effect.runPromise(Directories.use((directories) => directories.exists(path)).pipe(Effect.provide(bench.layer)))

export const directoriesLaws = (name: string, bench: () => Bench) =>
  describe(`${name} keeps the Directories laws`, () => {
    test("an existing directory exists", async () => {
      const b = bench()
      expect(await exists(b, b.directory)).toBe(true)
    })
    test("a file is not a directory", async () => {
      const b = bench()
      expect(await exists(b, b.file)).toBe(false)
    })
    test("a missing path does not exist", async () => {
      const b = bench()
      expect(await exists(b, b.missing)).toBe(false)
    })
  })
