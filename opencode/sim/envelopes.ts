// The background notices a JSON text carries (a model request, a session's
// context as JSON), in either envelope: mods/subagents/envelope.ts reads each
// string. The sims' laws, the scenarios and the real-OpenCode tests read
// notices through it.
import { Array as Arr, Option, Predicate, Schema } from "effect"
import { type Envelope, envelopes } from "../mods/subagents/envelope.ts"

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Arr.isArray(value)
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value) && !Arr.isArray(value)

/** The envelopes in every string a JSON value holds, in order. */
export function envelopesIn(value: Schema.Json): Envelope[] {
  if (Predicate.isString(value)) return envelopes(value)
  if (isJsonArray(value)) return value.flatMap((each) => envelopesIn(each))
  if (isJsonObject(value)) return Object.values(value).flatMap((each) => envelopesIn(each))
  return []
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** The envelopes in a JSON text's strings; none in text that is not JSON. */
export const envelopesInJson = (serialized: string): Envelope[] => Option.match(decodeJson(serialized), { onNone: () => [], onSome: envelopesIn })
