import { subagentsLaws } from "../laws.ts"
import * as MemorySubagents from "./subagents.ts"

subagentsLaws("memory Subagents", (world) => MemorySubagents.layer(world))
