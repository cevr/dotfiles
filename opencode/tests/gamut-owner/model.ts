import { argv } from "bun"
import { runOwnedSim } from "../../testbeds/gamut/sim-model.ts"
import { scratchInput } from "../read-path.ts"

runOwnedSim(scratchInput(argv[2] || ""))
