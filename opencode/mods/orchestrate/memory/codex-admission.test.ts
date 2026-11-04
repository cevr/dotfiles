import { codexAdmissionLaws } from "../laws.ts"
import * as MemoryCodexAdmission from "./codex-admission.ts"

codexAdmissionLaws("memory CodexAdmission", (world) =>
  MemoryCodexAdmission.layer((model, role) => world.find((entry) => entry.model === model && entry.role === role)?.answer),
)
