// The documents' `Look` over the file system. A path is looked at with one
// synchronous stat (filestore/unit-logs.ts `pathExists`): the simulated host
// runs it as plain plugin code, where an awaited read would wait outside its
// world.
import { Effect } from "effect"
import type { Look } from "../documents.ts"
import { pathExists } from "../filestore/unit-logs.ts"

/** Whether a path exists, file or folder, on the file system. */
export const look: Look = { exists: (target) => Effect.sync(() => pathExists(target)) }
