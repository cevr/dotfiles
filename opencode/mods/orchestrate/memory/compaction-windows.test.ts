import { compactionWindowsLaws } from "../laws.ts"
import * as MemoryCompactionWindows from "./compaction-windows.ts"

compactionWindowsLaws("memory CompactionWindows", (world) => MemoryCompactionWindows.layer(world))
