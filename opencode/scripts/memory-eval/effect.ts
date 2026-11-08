// Effect as mods/memory runs on it: the fork's copy that scripts/link-fork.ts
// links into the mod's node_modules, not the root's older one, so the memory
// model's services and the runtime that runs them are one version.
export { Effect, Layer, Schema } from "../../mods/memory/node_modules/effect/dist/index.js"
