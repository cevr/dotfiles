// Where a session whose directory is gone goes back to: the newest earlier
// location that still exists. Every move the host applies appends a
// location-switched message naming where the session went and where it left,
// so those messages, newest first, hold the whole history; the oldest one's
// previous location is where the session was made. Plain values, no I/O: the
// caller says which directories exist.

/** Where a session runs, as the host stores it. */
export interface Location {
  readonly directory: string
  readonly workspaceID?: string
}

/** One location-switched message: the location it moved to and the one it left. */
export interface Switch {
  readonly location: Location
  readonly previous?: { readonly location: Location }
}

/** What a recovery did: nothing (the directory exists), nothing it could (no earlier location exists), or a move. */
export type Outcome =
  | { readonly _tag: "Present" }
  | { readonly _tag: "Stranded" }
  | { readonly _tag: "Moved"; readonly target: Location }

export const Present: Outcome = { _tag: "Present" }
export const Stranded: Outcome = { _tag: "Stranded" }
export const Moved = (target: Location): Outcome => ({ _tag: "Moved", target })

/**
 * The newest location in `switches` (newest first) other than `current` for
 * which `exists` holds, or undefined when none does. Each switch offers its
 * destination before the place it left.
 */
export const recoverTarget = (
  current: string,
  switches: ReadonlyArray<Switch>,
  exists: (directory: string) => boolean,
): Location | undefined =>
  switches
    .flatMap((item) => (item.previous ? [item.location, item.previous.location] : [item.location]))
    .find((location) => location.directory !== current && exists(location.directory))

/** The toast after a move back, with both directories as `format` writes them (home as `~`). */
export const movedNotice = (target: Location, missing: string, format: (directory: string) => string) =>
  `Moved to ${format(target.directory)}: ${format(missing)} no longer exists`
