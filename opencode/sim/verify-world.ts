// The verify model on the world (sim/verify-model.ts reads the prompt): a world made with
// `script: worldScript` answers each prompt by its `verify:` directives.
import { Match } from "effect"
import { Answer, answer, TITLE, worldReading } from "./verify-model.ts"
import * as World from "./world.ts"

/** The verify model as a world's script: a title, a compaction, and every other request by its directives. */
export const worldScript: World.Script = (request) =>
  Match.value(request.kind).pipe(
    Match.when("title", () => World.say(TITLE)),
    Match.when("compaction", () => World.say("verify: compacted")),
    Match.orElse(() =>
      Answer.$match(answer(worldReading(request.text)), {
        Call: (call) => World.call(call.id, call.tool, call.input),
        Text: (text) => World.say(text.text),
      }),
    ),
  )
