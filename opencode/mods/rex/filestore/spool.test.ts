// The spool in files, in a scratch folder: a session with no spool reads as
// nothing shown, a write reads back, and keeping a new copy of the shown
// file drops the older one.
import { expect } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Effect } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { Spool } from "../service.ts"
import { empty, Picture } from "../spool.ts"
import * as FileSpool from "./spool.ts"

/** Hang guard for the test runner. */
const HANG_GUARD_MS = 120_000
const SESSION = "session:01a"

effectTest(
  "reads nothing shown, then what was written, and keeps one copy of the shown file",
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "rex-spool-"))),
    (root) =>
      Effect.gen(function* () {
        const source = join(root, "x.png")
        yield* Effect.sync(() => writeFileSync(source, "png"))
        const spool = yield* Spool
        expect(yield* spool.read(SESSION)).toEqual(empty)
        yield* spool.keep(SESSION, source)
        const copy = yield* spool.keep(SESSION, source)
        const spooled = { seq: 3, shown: Picture.make({ file: copy, name: "x.png" }) }
        yield* spool.write(SESSION, spooled)
        expect(yield* spool.read(SESSION)).toEqual(spooled)
        const files = yield* Effect.sync(() => readdirSync(join(root, FileSpool.folderOf(SESSION))).toSorted())
        expect(files).toEqual([basename(copy), "spool.json"].toSorted())
      }).pipe(Effect.provide(FileSpool.layer(root))),
    (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
  ),
  10_000,
)

effectTest(
  "names a session's folder with nothing that climbs out of the root",
  Effect.sync(() => expect(FileSpool.folderOf("session:01a/../x")).toBe("session_01a_.._x")),
  HANG_GUARD_MS,
)
