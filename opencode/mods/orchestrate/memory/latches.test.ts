import { latchesLaws } from "../laws.ts"
import * as MemoryLatches from "./latches.ts"

latchesLaws("memory Latches", (world) => MemoryLatches.layer({ ...MemoryLatches.empty(), refuse: world.refuse, fail: world.fail }))
