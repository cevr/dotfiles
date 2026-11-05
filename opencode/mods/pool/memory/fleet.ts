// The fleet held in memory: OpenCode's FleetStore (opencode/fleet.ts) over a
// storage kept in a map by key. Two layers over one map are two plugin
// instances on one host.
import type { Schema } from "effect"
import * as OpenCodeFleet from "../opencode/fleet.ts"
import { storage } from "./ledger.ts"

/** The fleet in `entries`, by key, as the plugin's storage keeps it. */
export const layer = (entries: Map<string, Schema.Json> = new Map()) => OpenCodeFleet.layer(storage(entries))
