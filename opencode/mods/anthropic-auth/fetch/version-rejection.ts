// Anthropic's refusal of the Claude Code version a request sent, read from a
// clone so the provider still gets the original body. Anything malformed,
// oversized, not JSON or not a 400 is no rejection.
import { Effect } from "effect"
import { contentLength } from "../content-headers.ts"
import {
  MAX_REJECTION_BODY_BYTES,
  parseClaudeCodeVersionRejection,
  type ClaudeCodeVersionRejection,
} from "../version.ts"
import { readBoundedText } from "./body.ts"

/** The rejection of `reportedVersion` that `response` carries, if it is one. */
export const detectClaudeCodeVersionRejection = (
  response: Response,
  reportedVersion: string,
): Effect.Effect<ClaudeCodeVersionRejection | undefined> => {
  if (response.status !== 400) return Effect.succeed(undefined)
  const declaredLength = contentLength(response.headers)
  if (declaredLength !== undefined && declaredLength > MAX_REJECTION_BODY_BYTES) return Effect.succeed(undefined)
  return readBoundedText(response.clone().body, MAX_REJECTION_BODY_BYTES, "Anthropic version rejection").pipe(
    Effect.map((body) => parseClaudeCodeVersionRejection(body, reportedVersion)),
    Effect.orElseSucceed(() => undefined),
  )
}
