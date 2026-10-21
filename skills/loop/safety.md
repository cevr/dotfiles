# SAFETY

Every loop agent (sweep, apply, counsel, live check) reads this file and `NORTH_STAR.md` → Owner rules in full before any action, and follows both. This is the one copy; each prompt points here instead of carrying the rules. Project-specific safety (a live binary, the owner's data, paid runs) lives in the owner rules.

SAFETY (mandatory; in gent, on 2026-09-23, a heredoc of guard probe text ran `rm -rf ~`):

- Create every file with the Write tool, never through a shell heredoc (`cat > f <<EOF`, quoted or not), `python3 -c`, `python3 - <<X` or `bun -e`.
- A destructive command string (rm, git reset, git clean, git push -f, dd, mkfs, chmod -R, find -delete, kill and similar) lives only as a string literal in a file created with the Write tool, run with `bun <file>`. It stays out of every shell command line, heredoc, `echo`, `python3 -c`, `bun -e` and commit message; commit with `-m "..."` or `git commit -F <file written with Write>`.
- Probe strings target only harmless paths such as `/nonexistent/loop-probe-x`; never `~`, `$HOME`, `/`, `.` or a real repo path.
- Delete with `trash`. Unstage with `git restore --staged <file>`. Read old code with `git show <commit>:<path>`; `git stash` is shared across workspaces and stays unused.
- The owner's data (a database, a session store) is read only as a copy: `/bin/cp` it (and its `-wal`) into the scratch directory, and open the copy read-only. Never write to it, commit it or publish it.
- Never read or print credentials, tokens or private content, and never put them in a report, a ledger or a commit.
- No model or API call that costs money, unless the owner rules name the run and the agent allowed to make it.
