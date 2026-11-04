import { Schema } from "effect"
import { explain, Place } from "../Sabbath.ts"

/** It is the Sabbath, or the half hour after it, at the place: no agent works until `resumesAt`. */
export class SabbathRest extends Schema.TaggedError<SabbathRest>()("SabbathRest", {
  resumesAt: Schema.Number,
  place: Place,
}) {
  /** The Claude Code mod's sentence: when work resumes, and where. */
  get why(): string {
    return explain(this.resumesAt, this.place)
  }
}
