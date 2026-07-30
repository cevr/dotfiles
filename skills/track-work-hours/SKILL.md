---
name: track-work-hours
description: Log, remove, and review Cristian's Bite work hours in the 2026 Google Sheets payroll workbook. Use when Cristian asks to enter, change, clear, check, or summarize daily hours or the current payroll tracking period.
---

# Track Work Hours

Use the bundled `hours` command. It finds the existing date row and writes only the `Hours Worked` and `Notes` cells.

## Agent rules

1. Use `hours show --json` for the current status.
2. Pass `--date YYYY-MM-DD` when the user names a date.
3. Treat a request to log or change hours as an external write.
4. Run the same write with `--dry-run --json` first.
5. Perform the write only when the user requested it.
6. Add `--replace` only when the user asked to replace an existing value.
7. Use `hours clear` when the user asks to remove an entry.
8. Do not call `gog sheets update` or `gog sheets clear` directly.
9. Trust the command exit code.
10. Do not edit columns A through D.

## Commands

Show today's entry and payroll period:

```bash
hours show --json
```

Show another date:

```bash
hours show --date 2026-08-07 --json
```

Preview a write:

```bash
hours 7.5 --date 2026-08-07 --notes "Release work" --dry-run --json
```

Apply the verified write:

```bash
hours 7.5 --date 2026-08-07 --notes "Release work" --json
```

Replace an existing value:

```bash
hours 8 --date 2026-08-07 --replace --dry-run --json
hours 8 --date 2026-08-07 --replace --json
```

Remove an existing entry:

```bash
hours clear --date 2026-08-07 --dry-run --json
hours clear --date 2026-08-07 --json
```

Print the workbook URL:

```bash
hours sheet
```

## Setup

The dotfiles installer links `scripts/hours` to `~/.local/bin/hours`.

The command requires `gog` and `jq`. It uses `cristian@getbite.com` by default.

Override the account with `HOURS_GOOGLE_ACCOUNT`. Override the workbook with `HOURS_SPREADSHEET_ID`.

If Google rejects the token, run `gog auth add cristian@getbite.com --services sheets,drive,calendar --force-consent`.

If macOS blocks Keychain access, run `gog auth list` in a user terminal and select **Always Allow**.
