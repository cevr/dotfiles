// The memory network keeps the real network's laws (http/net-laws.ts).
import { Effect } from "effect"
import { HOST, netLaws } from "../http/net-laws.ts"
import * as MemoryNet from "./net.ts"

netLaws(
  "the memory network",
  Effect.sync(() => ({ net: MemoryNet.make().net(HOST), from: HOST })),
)
