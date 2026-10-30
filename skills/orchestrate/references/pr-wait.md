# Waiting on a team approval

Where main changes only through a PR that a teammate approves (Bite), green opens the PR (`create-pr`), and the unit goes to `waiting(pr)`. It holds no slot: start the next unit. Run one background until-loop on `gh pr view <n> --json reviewDecision,state` that exits when either changes. Approved or merged: back to decide. Changes requested: the comments go to a fresh implementor as the next round. On the workbox, decide held 27% of the week of 2026-10-17, mostly waiting for approvals, and the logs could not tell that wait from work.
