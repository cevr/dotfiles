import { sessionDirectoriesLaws } from "../laws.ts"
import * as MemorySessionDirectories from "./session-directories.ts"

sessionDirectoriesLaws("memory SessionDirectories", (world) => MemorySessionDirectories.layer(world))
