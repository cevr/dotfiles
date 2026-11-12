// The verdict on its own: each rule, the force-push allowance, paths read
// from the call's directory, `~` and `$HOME`, chained lines, `sh -c` and
// `eval`, and what stays allowed.
import { describe, expect, test } from "bun:test"
import { message, repoCandidates, verdict } from "./verdict.ts"

const HOME = "/Users/owner"
const CWD = "/Users/owner/work"
/** Repositories in this world: the work dir's `repo`, and the dotfiles one under the home. */
const REPOS = new Set([`${CWD}/repo`, `${HOME}/dotfiles`])

const judge = (command: string, cwd = CWD) => verdict(command, { cwd, home: HOME, isRepoRoot: (path) => REPOS.has(path) })
const reasonOf = (command: string, cwd = CWD) => {
  const answer = judge(command, cwd)
  return answer._tag === "Deny" ? answer.reason : undefined
}

describe("the verdict denies", () => {
  test("a recursive rm of the root, the home or a directory that holds it", () => {
    expect(reasonOf("rm -rf /")).toBe("`rm -rf /` would delete the root; name a narrower path")
    expect(reasonOf("rm -rf ~")).toBe("`rm -rf ~` would delete your home; name a narrower path")
    for (const command of ["rm -rf /*", "rm -rf ~/*", "sudo rm -rf ~", 'rm -fr "$HOME/"', "rm --recursive --force ${HOME}", "rm -rf $HOME/*", "rm -rf /Users", "rm -r ~"])
      expect([command, judge(command)._tag]).toEqual([command, "Deny"])
  })

  test("a recursive rm of the directory it runs in, one above it, or every file here", () => {
    for (const command of ["rm -rf .", "rm -rf *", "rm -rf ./*", 'rm -rf "$PWD"', "rm -rf ../work", "rm -rf repo/src/../.."])
      expect([command, reasonOf(command)]).toEqual([command, `\`${command.replaceAll('"', "")}\` would delete the directory it runs in; use \`trash\` on what you mean to remove`])
  })

  test("a recursive rm of a repository's root or its history", () => {
    expect(reasonOf("rm -rf repo")).toBe(`\`rm -rf repo\` would delete the repository at ${CWD}/repo; the owner removes a repository`)
    expect(reasonOf("rm -rf repo/")).toContain("would delete the repository at")
    expect(reasonOf(`rm -rf ${CWD}/repo`)).toContain("would delete the repository at")
    expect(reasonOf("rm -rf ~/dotfiles")).toBe(`\`rm -rf ~/dotfiles\` would delete the repository at ${HOME}/dotfiles; the owner removes a repository`)
    expect(reasonOf("rm -rf repo/.git")).toBe("`rm -rf repo/.git` would delete a repository's history; use `trash` on what you mean to remove")
    expect(reasonOf("rm -r -- repo")).toContain("would delete the repository at")
  })

  test("git reset --hard, whatever global options come before it", () => {
    expect(reasonOf("git reset --hard")).toBe("`git reset --hard` discards uncommitted work; stash it (`git stash -u`) or commit first")
    for (const command of ["git reset --hard HEAD~1", "git -C repo reset --hard", "git -c core.pager=cat reset --hard", "git --git-dir repo/.git --work-tree repo reset --hard", "git --config-env core.pager=PAGER reset --hard", "git --attr-source HEAD reset --hard", "git --no-pager --git-dir=repo/.git reset --hard"])
      expect([command, judge(command)._tag]).toEqual([command, "Deny"])
  })

  test("a forced git clean with -d, -x or -X that is not a dry run", () => {
    expect(reasonOf("git clean -fdx")).toBe("`git clean -fdx` deletes untracked files for good; run it with -n first and remove what you mean by path")
    for (const command of ["git clean -fd", "git clean -f -x", "git clean --force -d", "git clean -fX", "git --attr-source HEAD clean -fdx"]) expect([command, judge(command)._tag]).toEqual([command, "Deny"])
  })

  test("a git command with a global option the guard does not know, whatever follows: what git runs cannot be read", () => {
    expect(reasonOf("git --some-new-option HEAD reset --hard")).toBe(
      "`git --some-new-option HEAD reset --hard` passes git `--some-new-option`, an option the guard does not know, so it cannot tell what git runs; spell the command without it",
    )
    for (const command of ["git --some-new-option status", "git -C repo -Z log", "git --some-new-option=x reset --soft"]) expect([command, judge(command)._tag]).toEqual([command, "Deny"])
  })

  test("any simple command of a chained line, through prefixes, groups and assignments", () => {
    for (const command of [
      "echo hi && rm -rf ~",
      "true || git reset --hard",
      "echo done; git clean -fX | cat",
      "true & rm -rf ~",
      "echo hi\nrm -rf ~",
      "(rm -rf ~)",
      "{ rm -rf ~; }",
      "env rm -rf ~",
      "\\rm -rf ~",
      "FOO=1 rm -rf ~",
      "sudo -E rm -rf ~",
      "sudo -u root rm -rf ~",
      "nohup rm -rf ~",
      "command rm -rf ~",
      "/bin/rm -rf ~",
    ])
      expect([command, judge(command)._tag]).toEqual([command, "Deny"])
  })

  test("a cd moves where the next command runs", () => {
    expect(reasonOf("cd repo && rm -rf .")).toContain("would delete the directory it runs in")
    expect(reasonOf("cd scratch && rm -rf ../repo")).toContain(`would delete the repository at ${CWD}/repo`)
    expect(reasonOf("cd .. && rm -rf work")).toContain("would delete the directory it runs in")
    expect(reasonOf("cd && rm -rf dotfiles")).toContain(`would delete the repository at ${HOME}/dotfiles`)
    expect(reasonOf("cd /tmp && rm -rf ~/dotfiles")).toContain("would delete the repository at")
  })

  test("the script of sh -c, bash -c and eval, read where it runs", () => {
    for (const command of [
      "sh -c 'git reset --hard'",
      'bash -c "rm -rf ~"',
      "bash -lc 'cd repo && git clean -fdx'",
      "zsh -c 'echo hi; rm -rf ~/*'",
      "env FOO=1 bash -c 'git reset --hard'",
      "eval git reset --hard",
      "eval 'rm -rf ~'",
      "sh -c \"bash -c 'git reset --hard'\"",
      "cd repo && sh -c 'rm -rf .'",
    ])
      expect([command, judge(command)._tag]).toEqual([command, "Deny"])
  })

  test("paths are read from the call's directory, not the process's", () => {
    expect(judge("rm -rf repo", "/tmp")._tag).toBe("Allow")
    expect(reasonOf("rm -rf .", `${CWD}/repo`)).toContain("would delete the directory it runs in")
    expect(reasonOf("rm -rf ../repo", `${CWD}/scratch`)).toContain(`would delete the repository at ${CWD}/repo`)
  })
})

describe("the verdict allows", () => {
  test("a safe recursive rm, a plain rm, and paths quoted against expansion", () => {
    for (const command of [
      "rm -rf build",
      "rm -rf repo/build",
      "rm -rf repo/build/*",
      "rm -rf node_modules dist .cache",
      "rm -f ~/notes.txt",
      "rm notes.txt",
      // A quoted `~` is a directory named `~`, not the home.
      'rm -rf "~"',
      "rm -rf '~'",
      "rm -rf '$HOME'",
    ])
      expect([command, judge(command)._tag]).toEqual([command, "Allow"])
  })

  test("a force-push, a soft reset, a dry or narrow clean, and trash", () => {
    for (const command of [
      "git push --force origin main",
      "git push -f",
      "git reset --soft HEAD~1",
      "git reset HEAD file.ts",
      "git reset --hard-ish",
      "git clean -n -fdx",
      "git clean --dry-run --force -d",
      "git clean -f",
      "git status",
      "git --no-pager -C repo --literal-pathspecs log",
      "git --attr-source HEAD --exec-path=/usr/lib/git-core status",
      "git --version",
      "trash ~",
    ])
      expect([command, judge(command)._tag]).toEqual([command, "Allow"])
  })

  test("quoted text and a heredoc's body, which are data", () => {
    for (const command of [
      'git commit -m "revert; git reset --hard HEAD"',
      "echo 'a && git clean -fdx'",
      "git commit -F - <<'EOF'\ngit reset --hard\nEOF\ngit status",
      'cat > a.sh <<EOF\nrm -rf "$HOME"\nEOF',
      "echo sh -c 'git reset --hard'",
      "grep -r 'rm -rf ~' .",
    ])
      expect([command, judge(command)._tag]).toEqual([command, "Allow"])
  })
})

describe("the repository candidates", () => {
  test("are the targets of a recursive rm the other rules pass, once each, resolved", () => {
    const place = { cwd: CWD, home: HOME }
    expect(repoCandidates("rm -rf build ./build ~/dotfiles && rm -rf ~", place)).toEqual([`${CWD}/build`, `${HOME}/dotfiles`])
    expect(repoCandidates("rm notes.txt; git reset --hard", place)).toEqual([])
    expect(repoCandidates("cd repo && bash -c 'rm -rf src'", place)).toEqual([`${CWD}/repo/src`])
  })
})

test("a refusal reads as the Claude Code hook's", () =>
  expect(message("`git reset --hard` discards uncommitted work")).toBe("guard-destructive: `git reset --hard` discards uncommitted work."))
