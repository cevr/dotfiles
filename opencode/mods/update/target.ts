import { Option, Schema } from "effect"

/** The ref on the dotfiles origin that names the verified target: an annotated tag object. */
export const VERIFIED_REF = "refs/fleet/verified"

/** A full git commit name. */
export const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))

/**
 * What every host installs: the dotfiles commit and the fork commit an accepted batch verified
 * together, and the batch that accepted them.
 */
export const Target = Schema.Struct({ dotfiles: Commit, fork: Commit, batch: Schema.String })
export interface Target extends Schema.Schema.Type<typeof Target> {}

const TargetJson = Schema.fromJsonString(Target)
const decodeMessage = Schema.decodeUnknownOption(TargetJson)
const encodeMessage = Schema.encodeSync(TargetJson)

/** The tag's message: the target as one JSON line. */
export const messageOf = (target: Target): string => encodeMessage(target)

/** Who signs the tag, and when (epoch seconds). */
export interface Tagger {
  readonly name: string
  readonly email: string
  readonly at: number
}

/** The tag object `git mktag` writes for `target`: it points at the dotfiles commit and carries the target. */
export const tagObject = (target: Target, tagger: Tagger): string =>
  [`object ${target.dotfiles}`, "type commit", "tag fleet-verified", `tagger ${tagger.name} <${tagger.email}> ${Math.floor(tagger.at)} +0000`, "", messageOf(target), ""].join("\n")

/**
 * The target in a tag object as `git cat-file tag` prints it: its message, when it decodes and
 * names the commit the tag points at. Anything else is none.
 */
export const targetOfTag = (text: string): Option.Option<Target> => {
  const split = text.indexOf("\n\n")
  if (split < 0) return Option.none()
  const object = /^object ([0-9a-f]{40})$/m.exec(text.slice(0, split))
  return decodeMessage(text.slice(split + 2).trim()).pipe(Option.filter((target) => object?.[1] === target.dotfiles))
}

/** A short name for a target in a log line. */
export const shortTarget = (target: Target): string => `dotfiles ${target.dotfiles.slice(0, 10)}, fork ${target.fork.slice(0, 10)} (${target.batch})`
