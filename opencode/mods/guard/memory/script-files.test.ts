import { Effect } from "effect"
import { scriptFilesLaws } from "../laws.ts"
import * as MemoryScriptFiles from "./script-files.ts"

scriptFilesLaws("memory ScriptFiles", () =>
  Effect.succeed({
    layer: MemoryScriptFiles.layer({ "/tmp/run/probe.ts": "Bun.spawn([chrome])" }),
    script: "/tmp/run/probe.ts",
    text: "Bun.spawn([chrome])",
    none: ["/tmp/run/other.ts", "/tmp/run"],
  }),
)
