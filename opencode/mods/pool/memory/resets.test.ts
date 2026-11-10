import { resetsStoreLaws } from "../laws.ts"
import * as MemoryResets from "./resets.ts"

resetsStoreLaws("memory ResetsStore", () => {
  const entries = new Map()
  return () => MemoryResets.layer(entries)
})
