import { restartsLaws } from "../laws.ts"
import * as MemoryRestarts from "./restarts.ts"

restartsLaws("memory Restarts", (world) => {
  const memory = MemoryRestarts.empty({ directory: "/work" })
  for (const [id, session] of Object.entries(world.sessions))
    memory.sessions[id] = { id, ...(session.parentID === undefined ? {} : { parentID: session.parentID }), updated: session.updated, directory: session.here ? "/work" : "/elsewhere", messages: [] }
  if (world.fail !== undefined) memory.fail = world.fail
  if (world.refuseNotice !== undefined) memory.refuseNotice = world.refuseNotice
  return MemoryRestarts.layer(memory)
})
