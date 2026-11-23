// The memory record keeps the CommitmentRecord laws (laws.ts) the SQLite store keeps.
import { Effect } from "effect"
import { commitmentRecordLaws } from "../laws.ts"
import * as MemoryRecord from "./record.ts"

commitmentRecordLaws("the memory record", Effect.succeed(MemoryRecord.layer))
