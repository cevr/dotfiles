// POSIX paths as plain strings. The domain may not import `node:path`, and the
// guard needs only these three readings of a path the shell would use.

/** `to` read from the directory `from`, with `.`, `..` and repeated slashes folded; always absolute. */
export const resolve = (from: string, to: string): string => {
  const joined = to.startsWith("/") ? to : `${from}/${to}`
  const parts: Array<string> = []
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

/** Whether `inner` is `outer` or under it; both resolved. */
export const within = (inner: string, outer: string): boolean =>
  inner === outer || outer === "/" || inner.startsWith(`${outer}/`)

/** The last part of a resolved path. */
export const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)
