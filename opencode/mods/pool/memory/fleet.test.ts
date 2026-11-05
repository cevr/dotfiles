import { fleetStoreLaws } from "../laws.ts"
import * as MemoryFleet from "./fleet.ts"

fleetStoreLaws("memory FleetStore", () => {
  const entries = new Map()
  return () => MemoryFleet.layer(entries)
})
