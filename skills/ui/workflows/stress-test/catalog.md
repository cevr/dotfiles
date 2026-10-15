# Worst-case catalog

The scenario axes **Infer the scenarios** in [stress-test](../stress-test.md) selects from, and the realistic values that feed them. Each axis carries a cue: the property of the component that makes the axis worth running. Cue matches, axis stays; cue fails, axis is dropped and the drop is named in the plan.

An axis that stays contributes its scenarios as written here. Feed each one from the value tables, and add any value the component's own props make obviously worse, such as the longest option in a real dataset, copied into a fixture. Every value is something a real user could produce; the note beside it says what it tends to break. Each axis ends with the reference its breaks land in, which is the **Owner** in the report.

Use `example.com`, `example.org`, or `.test` domains for emails and URLs, so the fixture never points at a real inbox or site.

## Content length

**Cue: the component renders text it does not author.** User input, CMS content, API data, translations. A fixed label the codebase controls fails the cue.

| Scenario | What it catches |
| --- | --- |
| Empty string | Collapsed boxes, floating labels with nothing to float over, placeholder-only inputs |
| One word | Buttons and badges sized to their longest expected content |
| Typical content | The baseline the others are judged against |
| Several sentences | Wrapping, line-height at multiple lines, containers that assumed one line |
| One unbreakable string | A long URL or `Donaudampfschiffahrtsgesellschaft`: overflow with no wrap opportunity |

Feed it from [Text values](#text-values). Breaks land in [typography](../../references/typography/index.md) for wrapping and truncation, [layout](../../references/layout/index.md) where the container has no room and [writing](../../references/writing/index.md) where the source copy is the problem.

## Content shape

**Cue: the text can come from users or locales the team does not write in.** Same sources as content length, minus content the codebase fully controls.

| Scenario | What it catches |
| --- | --- |
| Emoji, alone and mixed into text | Line-height jumps, broken vertical centering, truncation splitting a character |
| RTL text | Direction handling, punctuation landing on the wrong side |
| Mixed-direction text | An LTR product name inside an RTL sentence, and the reverse |
| A right-to-left wrapper, where the product ships an RTL locale: `dir="rtl"`, `.environment(\.layoutDirection, .rightToLeft)`, `CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl)` | Icons, chevrons, padding, and the order of trailing actions |
| Diacritics and tall scripts | Clipped ascenders and descenders in tight line boxes |
| Numbers where columns align | Proportional figures wobbling in tables and timers |

Feed it from [Text values](#text-values) and [Numbers and money](#numbers-and-money). Breaks land in [typography](../../references/typography/index.md); spatial mirroring lands in [layout](../../references/layout/index.md).

## Text values

The values for both text axes, grouped by what kind of text the component renders.

### People and names

| Value | Breaks |
| --- | --- |
| `Aleksandra Wiśniewska-Kowalczyk` | Long, hyphenated, diacritics; wraps to two lines, and the hyphen is a line-break point |
| `Christopher Alexander Montgomery III` | Long with a suffix; naive first + last initials give `CI` |
| `Konstantin Oberhauser-Wettstein` | Long and compound; overflows single-line rows |
| `Jo` | Two letters; leaves the name column mostly empty, and naive initials give `J` |
| `J` | One letter; single-character initials, very short click target if the name is the link |
| `Ólafur Darri Ólafsson` | Leading accented capital; uppercase/sort logic, initials `ÓÓ` |
| `Đặng Thị Ngọc Hân` | Stacked Vietnamese diacritics; clipped by a tight line box that clips (`line-height` + `overflow: hidden`, a fixed text height) |
| `王秀英` | CJK, no spaces; "first + last word" initials logic finds one word, and CJK breaks anywhere |
| `نور الهدى عبد الرحمن` | RTL; punctuation and icons land on the wrong side without direction detection (`dir="auto"` on the web; native text detects it unless alignment is forced to left) |
| `Seán O'Brien-Ó Súilleabháin` | Apostrophe and accents; escaping, initials, search |
| `María José de la Cruz y Fernández` | Lowercase particles; initials `Md` or `MF`, sorting by "last name" |
| `dana` | All lowercase; initials should still be uppercase |
| `🦊 Fox` | Emoji first; `.charAt(0)` and Kotlin's `name[0]` return half a surrogate pair (`�`); Swift's `name.first` is whole |
| `👩🏽‍💻 Priya` | ZWJ emoji sequence; JS and Kotlin `.length` is 7+, slicing breaks it into pieces; Swift's `count` is 1 |
| `  Sam   Lee ` | Leading, trailing, and repeated spaces; initials from empty words, odd gaps |
| *(missing)* | No name at all, only an email; the UI must fall back to something |

### Emails, URLs, identifiers

Unbreakable strings: they have no spaces, so the text engine has no word boundary to wrap at.

| Value | Breaks |
| --- | --- |
| `bartholomew.fitzgerald@northwind-industries-holdings.example.com` | The classic. Pushes every sibling off the row where nothing lets it break |
| `a@b.co` | Shortest realistic; layout that assumed a long email looks empty |
| `first.last+billing-notifications@example.com` | Plus-addressing; validation that rejects `+`, display that truncates the meaningful part |
| `ops@sub.department.region.example.co.uk` | Many subdomains, two-part TLD; "domain" extraction logic |
| `https://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a?tab=comments&filter=unresolved` | Long URL; overflow, and end-truncation hides the part that differs |
| `9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f` | UUID; monospace width, middle-truncation candidate |
| `Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf` | File name; end-truncation hides the version and extension, brackets and dashes in paths |
| `IMG_20250914_183022_HDR_portrait_edited_edited.HEIC` | Camera file name; unbreakable, uppercase extension |
| `@a` / `@thisisaverylongusernamethatisallowed` | Handle extremes |

### Labels, titles, and copy from data

| Value | Breaks |
| --- | --- |
| `Senior Product Design Engineer, Platform Infrastructure` | Long job title; wraps to three lines in a secondary slot |
| `Invitation expired 12 days ago` | Long status badge; badge wraps or squeezes the name column |
| `Benachrichtigungseinstellungen` | German compound (30 chars, no spaces); label overflow, unbreakable |
| `Paramètres de confidentialité et de sécurité` | French expansion of "Privacy & security"; UI copy runs ~30% longer in translation |
| Twelve tags on one item: `design`, `frontend`, `q3`, `urgent`, `needs-review`, … | Tag rows that wrap into a wall; needs a `+8` overflow |
| A tag named `customer-feedback-from-enterprise-onboarding` | One tag wider than its container |
| `Untitled` / empty string / `   ` | Title missing; collapsed heading, zero-height row |
| `<script>alert(1)</script>` / `&amp;` / `**bold**` | Escaping; must render as literal text |
| `Line one` + newline + `Line two` | Newline in a single-line field; doubles row height or is silently dropped |
| A 2,000-character pasted description | Clamps, "show more", and textarea growth |

## Numbers and money

**Cue: the component renders a count, amount, percentage or measurement it does not author.**

| Value | Breaks |
| --- | --- |
| `0` | Zero states: "0 members", empty progress bar, division by zero in percentages |
| `1` | Plurals: "1 members", "1 days ago" |
| `1284` | Needs a thousands separator: `1,284` |
| `1000000` | Width of the count badge; consider compact form `1M` where precision doesn't matter |
| `12345678.9` as currency | `$12,345,678.90`; overflows totals columns |
| `-42.5` | Negative sign, red color logic, parentheses in accounting formats |
| `0.1 + 0.2` | `0.30000000000000004` rendered raw |
| `142%` / `-3%` | Progress bars and meters past their bounds |
| `null` / `undefined` / `NaN` | Rendered literally |
| `1.284` in `de-DE` vs `1,284` in `en-US` | Locale formatting; hardcoded separators are wrong for half the world |
| A value that changes live (`99` → `100`) | Width jump and jitter without tabular figures |

Figure alignment, width and formatting land in [typography](../../references/typography/index.md); plural wording such as "1 members" lands in [writing](../../references/writing/index.md); a bar or badge with no room lands in [layout](../../references/layout/index.md).

## Quantity

**Cue: the component repeats over items.** Lists, tables, grids, tag rows, avatar stacks. A singular component fails the cue.

| Scenario | What it catches |
| --- | --- |
| Zero items | Blank regions, missing empty states, and whether an empty state exists at all |
| One item | Grids and layouts designed around plural content; "1 of 1" |
| The realistic count | The baseline |
| The worst-case mix | The realistic count with a different failure in each of the first rows |
| Ten times the realistic count, and 1,000+ rows when the list is unpaginated | Missing scroll or pagination, performance collapse, sticky elements unsticking; also "Showing 40 of 1,284" copy |

Add these values where the component has them:

| Value | Breaks |
| --- | --- |
| Exactly page size, and page size + 1 | Off-by-one in "Showing 40 of 40", pagination that shows an empty page 2 |
| One item 10× the size of the others | Masonry and grid rows stretching to the tallest item |
| Items with identical names | Lists where the name is the only distinguishing field |

Zero-item breaks land in [writing](../../references/writing/index.md) for the empty state and [layout](../../references/layout/index.md) for the region; the rest land in [layout](../../references/layout/index.md).

## Time

**Cue: the component renders a timestamp, date or duration.**

| Value | Breaks |
| --- | --- |
| Now | "0 seconds ago" instead of "just now" |
| 12 days ago, 11 months ago, 3 years ago | Relative-time thresholds; switch to an absolute date after a week or so |
| A future date | "in 3 days" vs "-3 days ago" |
| `1970-01-01` | A zero timestamp shown as a real date |
| `2025-12-31T23:30:00-08:00` | Shows as a different day in UTC and the user's timezone |
| Very long duration (`1,284 hours`) | Duration formatting that never rolls up to days |

Format with the platform's relative-time and date formatters, never hand-built strings ([locale formatting](../../references/writing/patterns.md#locale-formatting); APIs: [web](../../platforms/web/writing.md#locale-formatting) · [Apple](../../platforms/apple/writing.md#locale-formatting) · [Android](../../platforms/android/writing.md#locale-formatting)). **Web:** `Intl.RelativeTimeFormat` and `Intl.DateTimeFormat`. Breaks land in [writing](../../references/writing/index.md).

## Images and media

**Cue: the component renders an image, avatar, logo or video.**

| Value | Breaks |
| --- | --- |
| Avatar URL that 404s | Broken-image icon instead of the initials fallback |
| No avatar at all | The fallback itself: initials, color, size parity with real avatars |
| 4000×200 panorama as avatar or cover | Distortion without cover scaling (`object-fit: cover`, `.scaledToFill()`, `ContentScale.Crop`) |
| 200×4000 tall image | Same, other axis; can also blow out a card's height |
| Transparent PNG logo, dark logo on dark mode | Invisible on the background |
| Slow-loading image | Layout shift without fixed dimensions or an aspect ratio (`aspect-ratio`, `.aspectRatio`, `Modifier.aspectRatio`) |

Breaks land in [surfaces](../../references/surfaces.md); a missing or wrong text alternative (`alt`, `accessibilityLabel`, `contentDescription`) lands in [accessibility](../../references/accessibility/index.md).

## State

**Cue: the component has the state.** Read the props and the interaction model; render only the states that arrive as props or data. A static component fails the cue entirely.

| Scenario | What it catches |
| --- | --- |
| Loading | Layout shift when content arrives, skeletons that don't match the final layout, spinners that shift content or have no accessible name |
| Error | No error state, a raw error message (`TypeError: Cannot read properties of undefined`), messages that overflow, color as the only signal |
| Disabled | Contrast collapse, focus behavior on disabled controls |
| Partial data | Some optional fields filled, others not, in the same list; misaligned rows |
| Every status at once | All enum values in one list (`active`, `invited`, `expired`, `suspended`); badge widths vary |
| No permission | Disabled actions; does the row still lay out the same? |
| The current user in the list | "You" labels, actions that shouldn't apply to yourself |

Focus and hover are the user's to try while they view the harness. Invite them to step through the instances with a keyboard in the report rather than simulating focus in the harness.

Breaks land in [accessibility](../../references/accessibility/index.md); an error message that names no recovery lands in [writing](../../references/writing/index.md); purely visual state polish lands in [surfaces](../../references/surfaces.md).

## Container

**Cue: always.** Everything renders inside something, and the component does not choose its container's width. Each width is a fixed container on the harness ([per platform](../harness.md#where-it-lives)), never a viewport or window to resize.

| Scenario | What it catches |
| --- | --- |
| The component's real container width | The baseline: a sidebar list is not a full-page list |
| A 320 container | Clipping, horizontal scroll, controls escaping the box; every overflow above, at once |
| A narrow sidebar, 280 | Components designed full-width, reused in a sidebar column |
| Squeezed by a flex or grid sibling | Min-content blowout, the component refusing to shrink |
| A very wide container, 2560 (web and desktop; on a phone or tablet, the widest supported window) | Unbounded measure, lines too long to read, stretched controls, content pinned to opposite edges or stranded on one side |

Breaks land in [layout](../../references/layout/index.md).

## Environment

**Cue: the project supports the mode.** These are viewing modes, not content. On the web the harness renders nothing for them: name them in the report for the user to toggle while viewing, since simulating one on the page, such as re-declaring dark tokens under a class, observes a different component. On Apple and Android a preview override sets the same environment value the system does, so render the baseline and the worst-case mix once more under each mode, per [Viewing modes](../harness.md#viewing-modes), and name the rest for the user.

| Mode | Web | Apple | Android | Breaks |
| --- | --- | --- | --- | --- |
| Dark, where a dark theme exists | OS dark mode | Dark appearance | Dark theme | Hardcoded colors, invisible borders and logos |
| Largest text | Browser zoom 200%, large text setting | The largest accessibility Dynamic Type size, Bold Text | Font size at its largest (200%), Bold text | Fixed heights that clip growing text |
| Higher contrast | `prefers-contrast` | Increase Contrast, Reduce Transparency | High-contrast text | Hairlines and low-contrast tokens vanishing, translucent surfaces turning muddy |
| Reduced motion | `prefers-reduced-motion` | Reduce Motion | Remove animations | Motion that ignores the preference, or a state change carried by motion alone |
| The other input | A touch device | A pointer and hardware keyboard (iPad, Mac) | A hardware keyboard, Switch Access | Hover-only actions (the ••• that appears on hover) unreachable by touch; touch-only gestures unreachable by keyboard |

Dark-mode and contrast breaks land in [color](../../references/color/index.md); text size and motion land in [accessibility](../../references/accessibility/motion-and-zoom.md); touch breaks on the web land in [mobile web](../../platforms/web/mobile.md) and, for hit areas, [accessibility](../../references/accessibility/hit-areas.md); keyboard reach lands in [accessibility](../../references/accessibility/focus-and-keyboard.md).
