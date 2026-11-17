import { Effect } from "effect"
import { openAiKeyLaws } from "../laws.ts"
import { key, log } from "./backends.ts"

openAiKeyLaws("the recording key", (value) => Effect.map(log, (calls) => key(calls, value)))
