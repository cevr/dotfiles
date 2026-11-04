import { loginsLaws } from "../laws.ts"
import * as MemoryLogins from "./logins.ts"

loginsLaws("memory Logins", (world) =>
  MemoryLogins.layer({
    connections: new Map(
      [...world.logins].map(([pool, ids]) => [pool, ids.map((id) => ({ type: "credential", id, method: "oauth" }))] as const),
    ),
    marks: [],
  }),
)
