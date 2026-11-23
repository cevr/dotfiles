// The services the fork's plugin host gives a server plugin (`@opencode/plugin/effect` `Plugin.Environment`:
// FileSystem, Path and ChildProcessSpawner), on this machine: what a test's boundary provides in the host's place, so
// a plugin's adapter is proved on real files and processes without importing a platform itself.
import * as NodeServices from "@effect/platform-node/NodeServices"

/** The host's files, paths and processes, as a test provides them. */
export const hostServices = NodeServices.layer
