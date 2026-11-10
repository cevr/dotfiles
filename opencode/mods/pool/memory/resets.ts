// The Resets state held in memory: OpenCode's store (opencode/resets.ts) over
// a storage kept in a map by key, as the ledger's memory double is. The
// plugin's seam tests and the model's tests run on it.
import type { Schema } from "effect"
import * as OpenCodeResets from "../opencode/resets.ts"
import { storage } from "./ledger.ts"

/** The Resets state in `entries`, by key, as the plugin's storage keeps it. */
export const layer = (entries: Map<string, Schema.Json> = new Map()) => OpenCodeResets.layer(storage(entries))
