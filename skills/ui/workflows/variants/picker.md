# The picker

The control that switches variants in [variants](../variants.md). It sits beside the thing being judged, so build the spec and leave it alone.

The picker is the [state switcher](../states/switcher.md) with its names changed. Build that spec exactly — deliberately outside the design system, a grouped list that scales, the same behavior, structure, placement and CSS — and apply every rename below to selectors, classes, ids, labels and comments.

| In the switcher | In the picker |
| --- | --- |
| `__state` search param | `__variant` search param |
| `data-state` | `data-variant` |
| `.state-page`, and the container name `state-page` | `.variant-page`, container name `variant-page` |
| `.state-layout` | `.variant-layout` |
| `.state-switcher` | `.variant-picker` |
| `.state-switcher-group` | `.variant-picker-group` |
| `.state-switcher-heading` | `.variant-picker-heading` |
| `.state-switcher-select` | `.variant-picker-select` |
| `.state-stage` | `.variant-stage` |
| `aria-label="States"` on the `nav` | `aria-label="Variants"` |
| `aria-label="State"` on the `select` | `aria-label="Variant"` |
| Heading ids `states-<group>`, such as `states-data` | `variants-<group>`, such as `variants-density` |
| Group headings from **Find the states in the code**, such as `Data` | Group headings from **Name the axis before writing code**: the primary axis, such as `Density` |
| Rows named for states, such as `Loading`, `Empty` | Rows named for directions, such as `Quiet`, `Dense` |
| "The component", at its production width | "The piece", at its production width |

The 644px width and the `876px` container query in the switcher's CSS are examples there too: put the piece's production width in `max-width` and the grid column, and set the query to 232px plus it.

On Apple and Android, build the switcher's **On Apple and Android** section with the same renames: `__variant` for the launch argument and intent extra, previews named for directions such as `#Preview("Density · Quiet")` or `@Preview(name = "Quiet", group = "Density")`, and each preview rendering the containing screen rather than the piece alone.
