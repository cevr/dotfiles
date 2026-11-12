// The pushes held in memory: OpenCode's store (opencode/pushes.ts) over a
// storage kept in a map by key, as the resets' memory double is. Two layers
// over one map are two plugin instances on one host.
import type { Schema } from "effect"
import * as OpenCodePushes from "../opencode/pushes.ts"
import { storage } from "./ledger.ts"

/** The pushes in `entries`, by key, as the plugin's storage keeps them. */
export const layer = (entries: Map<string, Schema.Json> = new Map()) => OpenCodePushes.layer(storage(entries))
