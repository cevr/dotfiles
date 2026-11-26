// Which record file a checkout uses: one per repository per host, named by the repository's origin, so every checkout
// and workspace of one repository on a host (workspaces are full copies with the same origin) shares one file. With no
// origin, `local-` and the first 12 hex of the SHA-256 of the checkout's real path (the caller hashes it).
import { Option } from "effect"

/** A scheme (`https://`, `ssh://`), then a user (`git@`), then a port after the host (`:2222/`). */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//
const USER = /^[^@/]*@/
const PORT = /^([^/:]+):\d+(\/|$)/
const OUTSIDE = /[^a-z0-9._-]+/g
const EDGES = /^-+|-+$/g

/**
 * The key of the repository at origin `url`: lower-cased, its scheme, user, port and a trailing `.git` removed, every
 * run of characters outside `[a-z0-9._-]` made one `-` (`https://github.com/cevr/dotfiles.git` and
 * `git@github.com:cevr/dotfiles.git` both give `github.com-cevr-dotfiles`). None for a URL that leaves nothing.
 */
export const keyOfOrigin = (url: string): Option.Option<string> => {
  const lower = url.trim().toLowerCase()
  // A port only follows the host in a URL with a scheme: in scp form (`host:owner/name`) what follows `:` is the path.
  const hosted = Option.match(Option.liftPredicate(lower, (text) => SCHEME.test(text)), {
    onNone: () => lower.replace(USER, ""),
    onSome: (text) => text.replace(SCHEME, "").replace(USER, "").replace(PORT, "$1$2"),
  })
  const bare = hosted.replace(/\/+$/, "").replace(/\.git$/, "")
  return Option.liftPredicate(bare.replace(OUTSIDE, "-").replace(EDGES, ""), (key) => key !== "")
}

/** The key of a checkout with no origin, from the hex SHA-256 of its real path. */
export const localKey = (sha256: string): string => `local-${sha256.slice(0, 12)}`
