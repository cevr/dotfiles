import { sessionsLaws } from "../laws.ts"
import * as MemorySessions from "./sessions.ts"

sessionsLaws("memory Sessions", (world) => MemorySessions.layer(world))
