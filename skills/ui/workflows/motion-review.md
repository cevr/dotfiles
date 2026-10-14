# Motion review

Review the animation and motion code in a diff, file or component against a strict craft bar, and close with an explicit Block or Approve. Default to flagging; approval is earned. This mode reviews motion only. It does not write features, fix unrelated bugs or review non-motion code: for an interface-wide review run [review](review.md), which folds this mode's findings in under its `Motion` domain.

The bar lives in [motion standards](../references/motion/standards.md): the ten standards, the detection checklist, the remedial hierarchy, severity and the verdict rules. The exact values every fix cites live in [motion](../references/motion/index.md) and [recipes](../references/motion/recipes.md). Load them before judging anything.

## Operating posture

You are a senior design engineer with a brutal eye for craft. Your bias is toward **motion that feels right**, not motion that merely runs. A transition that "works" but feels sluggish, lands from the wrong origin, fires too often or drops frames is a regression, not a pass.

The review method (non-negotiable standards, escalation triggers, a remedial hierarchy, tiered output and explicit approval criteria) is adapted from aggressive code-quality review. Prefer CSS transitions, `@starting-style` and WAAPI for predetermined motion; JS and springs for dynamic, interruptible, gesture-driven motion.

## Steps

### 1. Resolve the scope

The invocation names the target: a file, a component, a branch, a pull request or uncommitted work. For a change, follow [scope resolution](review/scope-resolution.md) and read the whole diff before forming an opinion. A skimmed diff produces findings about code the next hunk already fixed. For a change, report what it caused; pre-existing motion problems are a short courtesy, not the review.

### 2. Inventory the motion

List every animation in scope: the element, what triggers it, its frequency tier, its named purpose, the tool (CSS transition, keyframes, `@starting-style`, WAAPI, Motion), the properties, the curve and the duration or spring config. Expand `transition: all` and Motion shorthands into what they actually animate. Read every state the component defines (hover, pressed, selected, open, loading, empty), with its durations and easings.

### 3. Measure

Hold each animation against the ten standards and sweep the detection checklist in [motion standards](../references/motion/standards.md). Escalate checklist hits on sight. For anything that drops frames, name the cause from [motion performance](../references/motion/performance.md#diagnosing-jank) before proposing a fix. For drags, sheets and swipes, check [gestures](../references/motion/gestures.md).

### 4. Choose each fix

Walk the [remedial preference hierarchy](../references/motion/standards.md#remedial-preference-hierarchy): deleting the animation beats reducing it, which beats retuning it. When a value is needed (a curve, a duration, a spring config), pull the exact one from [motion](../references/motion/index.md) or [recipes](../references/motion/recipes.md) rather than approximating. Rate each finding on the [severity](../references/motion/standards.md#severity) scale.

### 5. Verify

Without a browser, read every state from the code. With one, walk each state and replay the motion at 10% speed in the browser's Animations panel, step coordinated properties frame by frame, and toggle `prefers-reduced-motion` in the Rendering panel. Gestures need a real device. Report every check you could not run as `Not verified`. When feel genuinely can't be settled from code, say so and recommend slow motion, frame-by-frame inspection and a fresh look the next day instead of guessing.

## Output format

Two parts, in this order.

### Part 1: Findings table (required)

A single markdown table, one row per root cause, listing every location it appears in, ordered by severity. Cite `file:line`. `Why` names the standard broken and the user impact.

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| HIGH | `Dropdown.css:14` | `transition: all 300ms ease-in` | `transition: transform 200ms var(--ease-out), opacity 200ms var(--ease-out)` | `ease-in` delays the moment the user watches most; `all` animates unintended properties off the compositor |
| HIGH | `Popover.tsx:22` | `transform: scale(0)` | `transform: scale(0.95); opacity: 0` | Nothing appears from nothing; `scale(0)` looks like it came from nowhere |
| MEDIUM | `Popover.css:8` | `transform-origin: center` | `transform-origin: var(--transform-origin)` | Popovers scale from their trigger, not center (modals are exempt) |
| MEDIUM | `Button.tsx:31` | `active:scale-95` | `enabled:active:scale-[0.96]` | Press scale is exactly `0.96`, and a disabled button never scales |

Never write the findings as a list with "Before:" and "After:" on separate lines:

```
Before: transition: all 300ms
After: transition: transform 200ms ease-out
────────────────────────────
Before: scale(0)
After: scale(0.95)
```

### Part 2: Verdict (required)

Group remaining commentary by impact tier, highest first. Omit empty tiers.

1. **Feel-breaking regressions**: sluggish easing, comes-from-nowhere, fires on high-frequency or keyboard actions.
2. **Missed simplifications**: animations that should be removed or drastically reduced.
3. **Performance**: non-compositor properties, dropped-frame risks, recalc storms.
4. **Interruptibility and timing**: keyframes where transitions or springs belong; symmetric timing that should be asymmetric.
5. **Origin, physicality and cohesion**: wrong origin, mismatched personality, jarring crossfades.
6. **Accessibility**: reduced-motion and pointer/hover gating.

Close with an explicit **Block** or **Approve** under the [verdict rules](../references/motion/standards.md#verdict), followed by what was verified and what was `Not verified`. With nothing to report, state "No actionable motion findings" and report verification.

## Before you finish

- Every finding cites `file:line` and an exact target value from the motion references, never an approximation.
- Every row names the standard it breaks; nothing is flagged on taste alone.
- Exempt cases were not reported: `transform-origin: center` on a modal, a longer duration on a marketing page, a keyword easing in a recipe that specifies it.
- The verdict is Block whenever any HIGH remains, and no Approve covers code you did not inspect.
