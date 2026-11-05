import { expect, test } from "bun:test"
import { basename, resolve, within } from "./path.ts"

test("resolve folds `.`, `..` and repeated slashes, and keeps an absolute target", () => {
  expect(resolve("/a/b", "c/./d//")).toBe("/a/b/c/d")
  expect(resolve("/a/b", "../../..")).toBe("/")
  expect(resolve("/a/b", "/x/../y")).toBe("/y")
  expect(resolve("/a/b", "")).toBe("/a/b")
})

test("within holds for the path itself and anything under it, not for a sibling with the same prefix", () => {
  expect(within("/a/b", "/a/b")).toBe(true)
  expect(within("/a/b/c", "/a/b")).toBe(true)
  expect(within("/a/bc", "/a/b")).toBe(false)
  expect(within("/a", "/")).toBe(true)
})

test("basename is the last part", () => expect(basename("/a/b/.git")).toBe(".git"))
