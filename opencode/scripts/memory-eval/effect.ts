// Effect as the mods run on it: the fork's copy that scripts/link-fork.ts
// links into each mod's node_modules (mods/memory, mods/pool and
// mods/anthropic-auth link the same one), not the root's older one, so the
// mods' models and the runtime that runs them are one version.
export { Effect, Layer, Result, Schema } from "../../mods/memory/node_modules/effect/dist/index.js"
