import { poolPaceLaws } from "../laws.ts"
import * as MemoryPoolPace from "./pool-pace.ts"

poolPaceLaws("memory PoolPace", (world) => MemoryPoolPace.layer(world))
