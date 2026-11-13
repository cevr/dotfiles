// The in-memory memory files keep the NoteStore laws, as the SQLite file does
// (sqlite/store.test.ts). That one path is one database to every opener, and
// that a failed write leaves the file as it was, are what the simulated tests
// read: cmd/memory/memory.sim.test.ts (the CLI reads the plugin's file) and
// cmd/memory/memory-faults.sim.test.ts (the file holds exactly the notes kept).
import { Effect, Layer } from "effect"
import { noteStoreLaws } from "../laws.ts"
import * as MemoryFiles from "./files.ts"

noteStoreLaws("the in-memory memory files", () => Layer.unwrap(Effect.map(MemoryFiles.make, (held) => held.files("/state/memory.db"))))
