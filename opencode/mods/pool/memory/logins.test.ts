import { loginsLaws } from "../laws.ts"
import * as MemoryLogins from "./logins.ts"

const labelOf = (labels: ReadonlyMap<string, string>, id: string) => {
  const label = labels.get(id)
  return label === undefined ? {} : { label }
}

loginsLaws("memory Logins", (world) =>
  MemoryLogins.layer({
    connections: new Map(
      [...world.logins].map(([pool, ids]) => [pool, ids.map((id) => ({ type: "credential", id, method: "oauth", ...labelOf(world.labels, id) }))] as const),
    ),
    marks: [],
  }),
)
