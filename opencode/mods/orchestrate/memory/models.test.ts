import { modelsLaws } from "../laws.ts"
import * as MemoryModels from "./models.ts"

modelsLaws("memory Models", (world) => MemoryModels.layer(world.model, world.variants, world.others))
