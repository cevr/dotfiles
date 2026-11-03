# Waiting on a team approval

Where main changes only through a PR that a teammate approves (a team repo), green opens the PR (`create-pr`), and the unit goes to `waiting(pr)`. It holds no slot: start the next unit. Run one background until-loop on `gh pr view <n> --json reviewDecision,state` that exits when either changes. Approved or merged: back to decide. Changes requested: the comments go to a fresh implementor as the next round. Without the `waiting(pr)` state, the wait for approvals reads as time spent in decide, and the logs cannot tell it from work.
