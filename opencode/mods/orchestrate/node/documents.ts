// The documents' `Look` over the file system, and the principles folder of
// this dotfiles checkout, found from this file (mods/orchestrate/node → the
// checkout's `principles/`), so it is right wherever the checkout lives, on
// the Mac and on the workbox. A path is looked at with one synchronous stat
// (filestore/unit-logs.ts `pathExists`): the simulated host runs it as plain
// plugin code, where an awaited read would wait outside its world.
import { fileURLToPath } from "bun"
import { Effect } from "effect"
import type { Look } from "../documents.ts"
import { pathExists } from "../filestore/unit-logs.ts"

/** The principles folder of this checkout. */
export const principles: string = fileURLToPath(new URL("../../../../principles", import.meta.url))

/** Whether a path exists, file or folder, on the file system. */
export const look: Look = { exists: (target) => Effect.sync(() => pathExists(target)) }
