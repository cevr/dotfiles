import { Schema } from "effect"

/** A launch receipt is not the child's ongoing lifecycle. In particular, a check is not completion. */
export const LaunchStatus = Schema.Literals(["completed", "running", "latched", "checking", "unknown"])
export type LaunchStatus = typeof LaunchStatus.Type
export const readLaunchStatus = Schema.decodeUnknownOption(LaunchStatus)
