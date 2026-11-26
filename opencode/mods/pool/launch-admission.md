# Adaptive worker admission

The quota reading lags work already launched. A fixed launch charge also misses differences between jobs, and the former quote omitted the proposed worker's own charge. Independent hosts could both spend the same apparent room. Owner-facing root sessions need to remain usable while workers wait for the weekly line.

## Caller contract

Orchestrate calls `reserveLaunch({ providerID, model, sessionID, launchID })` immediately before starting a new child, including when reopening a latch. A refusal latches that child. An accepted launch is bound to the resulting child with `bindLaunch`; follow-ups do not count as new launches. Launch identities are host-qualified and retries within the settlement window return the original frozen reservation.

The pool obtains positive agreement from every configured peer, reads their current reports after agreement, adds the proposed worker's estimate to their unsettled starts, and writes and confirms its own reservation before answering. The existing per-provider lease arbitrates competing hosts and reset claims. Missing, incompatible or clock-skewed peers hold new launches. Root replies and compaction do not require launch agreement.

## Learning

The configured `startCost` is the cold-start floor. Completed workers contribute whole-agent shared weekly cost estimated from actual token classes and the limit tally's measured model-family rate. Three completed samples in the past hour select that cohort; otherwise use the past day, adding floor-valued prior samples until the cohort has three observations. Running work, missing messages and uncalibrated records do not masquerade as cheap completed jobs.

The first completion's message identities are frozen independently of binding, so a fast child can finish before its tool returns. Later follow-ups do not enlarge that sample. Starts retain their admitted estimate until the settlement window expires; a later forecast never reprices earlier starts. Host storage and the shared token records survive reloads and restarts.

## Priority

The server derives priority from session ancestry. Root primary messages and compaction bypass the soft weekly line and its safety margins while a usable account has actual quota. Child work and auxiliary requests keep ordinary pacing. Required quota evidence, spent windows, model limits and sign-in holds still bind roots. Callers cannot select priority through the launch RPC.

## Design decision and limits

The initial alternatives were per-request quota escrow and negotiated launch estimates. Two sketches came from the same model family. The owner's clarification selected launch estimates: work varies, overshoot is acceptable, and later launches should adapt. The public surface therefore exposes only reserve and bind; token accounting, history selection, persistence and peer negotiation remain inside the pool.

This is statistical pacing, not a bound on future spend. Long jobs and provider reporting lag can overshoot; pending estimates can temporarily overcount spend already visible in quota readings. A lost reply conservatively leaves the estimate until settlement. Peer agreement trades worker availability during partitions for a common view of launches; owner messages remain independent of that agreement.

Older pools retain the orchestrator's prior admission and legacy start accounting. Negotiated admission requires both hosts to advertise protocol 1; deploy both before relying on it. The ordinary Quint model covers supplied total charge, and replay checks its decomposition into heterogeneous pending estimates plus a candidate. It does not prove future cost or network/persistence behavior; the two-host, learning and latch tests exercise those seams.
