# Dogfood a web app with browse

Explore a web app as a user, find bugs and UX problems, and write a report in which every finding carries its reproduction evidence. Only the target URL is required; start with these defaults unless the owner overrides them:

| Parameter | Default |
| --- | --- |
| Target | (required), e.g. `http://localhost:3000` or `app.example.com` |
| Session | the slugified host, e.g. `app-example-com` |
| Output | `./dogfood-output/` (outside any checkout you would commit) |
| Scope | the whole app |
| Auth | the owner's logged-in Chrome; a login goes through `handoff` |

You test as a user: findings come from what the browser shows, never from reading the app's source.

## 1. Set up

```bash
mkdir -p dogfood-output/screenshots dogfood-output/videos
browse session new app-example-com --allow-origin app.example.com
```

Copy the report template (end of this file) to `dogfood-output/report.md` and fill its header. Screenshots and videos land in browse's file root on the host that runs the command (`files.dir`); copy them into `dogfood-output/` as you go, so the report's relative links resolve.

## 2. Orient

```js
await page.goto(TARGET)
await page.waitForLoadState("domcontentloaded")
const labels = await screenshotWithLabels({ path: files.path("initial.png") })
return { url: page.url(), outline: await snapshot() }
```

From the snapshot, list the top-level sections to visit. If you land on a login page, `handoff` it to the owner, then verify the destination.

## 3. Explore, one execute per page

Visit each section; in each, use the controls a user would: buttons, forms (empty, invalid, boundary and realistic input), dropdowns, modals, the back button, deep links, empty and overflow states, and phone width (`page.setViewportSize({ width: 390, height: 844 })`). Collect errors around the actions:

```js
await pageConsole.start()
const bad = []
page.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url()}`) })
page.on("requestfailed", (r) => bad.push(`failed ${r.url()} ${r.failure()?.errorText}`))
await page.goto(`${TARGET}/settings`)
await page.getByRole("button", { name: "Save" }).click()
await page.getByRole("status").waitFor()
await page.screenshot({ path: files.path("settings-001.png") })
await pageConsole.stop()
return { bad, outline: await snapshot() }
```

The result's `logs` carry the page's console errors and uncaught exceptions; the aftermath line counts them. Spend the most time on core workflows; dig deeper where issues cluster.

## 4. Document each issue as you find it

Stop exploring and write the issue into the report at once, then continue. Reproduce it once more before collecting evidence: a finding that does not reproduce is not filed.

- **Interactive issue** (a broken control, a wrong state, an error on action): record a video, and screenshot every step.

  ```bash
  browse recording start dogfood-output/videos/issue-003.webm --session app-example-com --mode cdp
  browse execute --session app-example-com --file repro-003.js   # one screenshot per step, a 1 s pause between steps
  browse recording stop --session app-example-com
  ffprobe -v error -show_entries format=duration -of csv=p=0 dogfood-output/videos/issue-003.webm
  ```

  In the repro script, use `pressSequentially` for typed text so the video shows typing, and take `screenshotWithLabels` of the broken state.
- **Static issue** (a typo, clipped text, a layout glitch, an error on load): one labeled screenshot; the video column is `N/A`.
- **Intermittent issue**: keep `flight-recorder start --session <s> --retention-ms 60000` running while exploring, and `flight-recorder save-last` right after it appears.

Number issues ISSUE-001, ISSUE-002, … and write numbered repro steps, each pointing at its screenshot.

## 5. Wrap up

Aim for 5 to 10 well-evidenced issues. Recount the summary table so it matches the `### ISSUE-` blocks, delete the session and tidy the tabs (`browse session delete <s>`, `browse tabs cleanup --idle-minutes 0`), and tell the owner the totals by severity and the most severe items, with the report path.

## Issue taxonomy

Severity: **critical** blocks a core workflow, loses data or crashes; **high** breaks a major feature with no workaround; **medium** works with a noticeable problem and a workaround; **low** is cosmetic.

- **Visual**: misaligned or overlapping elements, clipped text, broken images or icons, dark-mode rendering, responsive layout, z-index stacking, fonts, contrast, animation glitches.
- **Functional**: broken links, controls that do nothing, validation that rejects valid or accepts invalid input, wrong redirects, silent failures, state lost on refresh, double submits, broken search, filter or pagination, upload or download failures.
- **UX**: unclear navigation, no loading feedback, slow interactions (over 300 ms), unclear errors, destructive actions without confirmation, dead ends, inconsistent patterns, focus problems, unhelpful empty states.
- **Content**: typos, stale or wrong text, placeholder text, truncation without a way to read the rest, wrong labels, inconsistent terms.
- **Performance**: loads over 3 s, jank, layout shift, excessive requests, slowing over time, oversized images.
- **Console**: exceptions, 4xx and 5xx responses, CORS and mixed-content errors, unhandled rejections.
- **Accessibility**: missing alt text, unlabeled inputs, no keyboard path, focus traps, missing ARIA on dynamic content (check with `ariaSnapshot()` and an axe run, as in SKILL.md).

## Report template

```markdown
# Dogfood Report: {APP_NAME}

| Field | Value |
|-------|-------|
| **Date** | {DATE} |
| **App URL** | {URL} |
| **Session** | {SESSION} |
| **Scope** | {SCOPE} |
| **Viewport** | {e.g. 1024×640 CSS px at 125% zoom; 312×675 phone} |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | **0** |

## Issues

### ISSUE-001: {Short title}

| Field | Value |
|-------|-------|
| **Severity** | critical / high / medium / low |
| **Category** | visual / functional / ux / content / performance / console / accessibility |
| **URL** | {page URL} |
| **Repro Video** | {path, or N/A for a static issue} |

**Description**: {what is wrong, what was expected, what happened}

**Repro Steps**

1. Navigate to {URL}
   ![Step 1](screenshots/issue-001-step-1.png)
2. {Action}
   ![Step 2](screenshots/issue-001-step-2.png)
3. **Observe:** {what goes wrong}
   ![Result](screenshots/issue-001-result.png)
```
