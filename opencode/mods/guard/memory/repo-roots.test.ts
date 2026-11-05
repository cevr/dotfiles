import { Effect } from "effect"
import { repoRootsLaws } from "../laws.ts"
import * as MemoryRepoRoots from "./repo-roots.ts"

repoRootsLaws("memory RepoRoots", () =>
  Effect.succeed({
    layer: MemoryRepoRoots.layer({ repos: ["/work/repo"], unreadable: ["/work/locked/inner"] }),
    repo: "/work/repo",
    inside: "/work/repo/src",
    plain: "/work/plain",
    missing: "/work/nowhere",
    unreadable: "/work/locked/inner",
  }),
)
