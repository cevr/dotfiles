# Untitled

Generated from the current project, including edits awaiting autosave. Return to the [theme index](../themes.md). Install the selected fonts and icons using the setup below; assets are acquired separately from their official sources.

## Font and icon setup

Follow [asset installation](../assets.md) when implementing this theme. Download and configure the selected free assets from their official sources; no font files or icon artwork are bundled. Weights below are the authored requests: load matching static faces or a variable range and report any unavailable weight. Register the exact family aliases below, or map the role tokens to the loader’s actual family.

| Selected font | Roles | Weights | Family stack | Setup |
| --- | --- | --- | --- | --- |
| <code>Timeless Grotesk</code> (free) | brand, ui, editorial, data | 400, 500, 600 | <code>"Timeless Grotesk", sans-serif</code> | Download and load [Timeless Grotesk](https://timeless.co/type) in the app. Use the vendor’s Grotesk cut; if using Timeless Sans variable files, pin STYL to 0, with ital 0 for upright or 100 for required italic faces. |

### Icons

Selected: [Lucide](https://lucide.dev/guide/react/getting-started), outlined. Install and wire the selected free pack (React: <code>lucide-react</code>); reuse it if already installed. Use the official adapter for other frameworks.

Preserve icon size, color, weight, style, and accessible names. Match the selected style only where the pack supports it; Lucide’s official pack supplies outlines, so report a filled-style gap rather than claiming exact filled artwork. Keep existing package versions and add only missing packages using the receiving project’s package manager.

## Foundations

```json
{
  "name": "Untitled",
  "text": {
    "l": {
      "size": 20,
      "lineHeight": 27
    },
    "m": {
      "size": 14,
      "lineHeight": 20
    },
    "s": {
      "size": 12,
      "lineHeight": 17
    },
    "xl": {
      "size": 31,
      "lineHeight": 34
    },
    "xs": {
      "size": 10,
      "lineHeight": 14
    },
    "xxl": {
      "size": 41,
      "lineHeight": 44
    },
    "xxs": {
      "size": 9,
      "lineHeight": 12
    }
  },
  "fonts": {
    "ui": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": {
        "regular": 400,
        "medium": 500,
        "heavy": 600
      }
    },
    "brand": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": {
        "regular": 400,
        "medium": 500,
        "heavy": 600
      }
    },
    "editorial": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": {
        "regular": 400,
        "medium": 500,
        "heavy": 600
      }
    },
    "data": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": {
        "regular": 400,
        "medium": 500,
        "heavy": 600
      }
    }
  },
  "border": {
    "l": 0,
    "m": 0,
    "s": 0,
    "none": 0
  },
  "radius": {
    "l": 12,
    "m": 8,
    "s": 4,
    "xl": 20,
    "xs": 2,
    "full": 9999,
    "zero": 0
  },
  "shadows": {
    "l": {
      "x": 0,
      "y": 16,
      "blur": 48,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 0
    },
    "m": {
      "x": 0,
      "y": 8,
      "blur": 24,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 12
    },
    "s": {
      "x": 0,
      "y": 2,
      "blur": 4,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 0
    }
  },
  "spacing": {
    "l": 15,
    "m": 10,
    "s": 8,
    "xl": 20,
    "xs": 5,
    "xxl": 31,
    "xxs": 3,
    "zero": 0
  },
  "animation": {
    "large": {
      "easing": [
        0.22,
        1,
        0.36,
        1
      ],
      "duration": 360
    },
    "easing": [
      0.16,
      1,
      0.3,
      1
    ],
    "duration": 200,
    "popupScale": 0.96,
    "pressDistance": 1
  },
  "iconStyle": "outlined",
  "iconFamily": "Lucide",
  "neutralTone": "cool",
  "buttonRadius": "s",
  "colorEmphasis": 0,
  "letterSpacing": {
    "l": 0.01,
    "m": 0,
    "s": -0.01,
    "xl": 0.02,
    "xs": -0.02
  },
  "primaryForeground": {
    "dark": "neutral-9",
    "light": "neutral-2"
  },
  "primaryActionColor": "neutral-10"
}
```

## light CSS variables

Define these in the app’s existing theme scope for this mode. Keep component styles linked to the variables.

| Variable | Value |
| --- | --- |
| `--theme-name` | Untitled |
| `--theme-icon-family` | Lucide |
| `--theme-icon-style` | outlined |
| `--toolbar-divider-bleed` | 0 |
| `--focus-ring-outline` | initial |
| `--icon-stroke-width` | 2 |
| `--icon-light-display` | none |
| `--icon-regular-display` | inline |
| `--icon-bold-display` | none |
| `--motion-duration` | 200ms |
| `--motion-easing` | cubic-bezier(0.16, 1, 0.3, 1) |
| `--motion-type` | easing |
| `--motion-visual-duration` | 0.2 |
| `--motion-bounce` | 0.2 |
| `--motion-enabled` | 1 |
| `--motion-small-iterations` | infinite |
| `--motion-large-duration` | 360ms |
| `--motion-large-easing` | cubic-bezier(0.22, 1, 0.36, 1) |
| `--motion-large-type` | easing |
| `--motion-large-visual-duration` | 0.36 |
| `--motion-large-bounce` | 0.2 |
| `--motion-large-iterations` | infinite |
| `--motion-popup-scale` | 0.96 |
| `--motion-press-distance` | 1px |
| `--option-badge-background` | #e5e7eb |
| `--option-badge-foreground` | #000000 |
| `--navigation-active-foreground` | #000000 |
| `--emphasis-chart-fill` | #07376b33 |
| `--emphasis-balance-background` | #c8ced5 |
| `--emphasis-rewards-background` | #f3f4f6 |
| `--emphasis-icon-background` | #f3f4f6 |
| `--emphasis-icon-foreground` | #000000 |
| `--emphasis-type-background` | #f3f4f6 |
| `--emphasis-type-foreground` | #000000 |
| `--navigation-active-background` | #e5e7eb |
| `--surface-raised-image` | none |
| `--surface-raised-shadow` | 0 0 0 0 transparent |
| `--surface-recessed-image` | none |
| `--surface-recessed-shadow` | 0 0 0 0 transparent |
| `--space-zero` | 0px |
| `--space-xxs` | 3px |
| `--space-xs` | 5px |
| `--space-s` | 8px |
| `--space-m` | 10px |
| `--space-l` | 15px |
| `--space-xl` | 20px |
| `--space-xxl` | 31px |
| `--tracking-xs` | -0.02em |
| `--tracking-s` | -0.01em |
| `--tracking-m` | 0em |
| `--tracking-l` | 0.01em |
| `--tracking-xl` | 0.02em |
| `--size-xxs` | 9px |
| `--line-xxs` | 12px |
| `--letter-spacing-xxs` | 0.02em |
| `--size-xs` | 10px |
| `--line-xs` | 14px |
| `--letter-spacing-xs` | 0.01em |
| `--size-s` | 12px |
| `--line-s` | 17px |
| `--letter-spacing-s` | 0.01em |
| `--size-m` | 14px |
| `--line-m` | 20px |
| `--letter-spacing-m` | 0em |
| `--size-l` | 20px |
| `--line-l` | 27px |
| `--letter-spacing-l` | -0.01em |
| `--size-xl` | 31px |
| `--line-xl` | 34px |
| `--letter-spacing-xl` | -0.01em |
| `--size-xxl` | 41px |
| `--line-xxl` | 44px |
| `--letter-spacing-xxl` | -0.02em |
| `--radius-zero` | 0px |
| `--radius-xs` | 2px |
| `--radius-s` | 4px |
| `--radius-m` | 8px |
| `--radius-l` | 12px |
| `--radius-xl` | 20px |
| `--radius-full` | 9999px |
| `--border-none` | 0px |
| `--border-s` | 0px |
| `--border-m` | 0px |
| `--border-l` | 0px |
| `--border-default-color` | #e5e7eb33 |
| `--border-shadow-none` | 0 0 0 0 transparent |
| `--border-shadow-s` | 0 0 0 0 transparent |
| `--border-shadow-m` | 0 0 0 0 transparent |
| `--border-shadow-l` | 0 0 0 0 transparent |
| `--font-ui` | "Timeless Grotesk", sans-serif |
| `--weight-ui-regular` | 400 |
| `--weight-ui-medium` | 500 |
| `--weight-ui-heavy` | 600 |
| `--font-brand` | "Timeless Grotesk", sans-serif |
| `--weight-brand-regular` | 400 |
| `--weight-brand-medium` | 500 |
| `--weight-brand-heavy` | 600 |
| `--font-editorial` | "Timeless Grotesk", sans-serif |
| `--weight-editorial-regular` | 400 |
| `--weight-editorial-medium` | 500 |
| `--weight-editorial-heavy` | 600 |
| `--font-data` | "Timeless Grotesk", sans-serif |
| `--weight-data-regular` | 400 |
| `--weight-data-medium` | 500 |
| `--weight-data-heavy` | 600 |
| `--color-none` | transparent |
| `--color-1` | #07376b |
| `--color-1-transparent` | #07376b33 |
| `--color-2` | #ff5a00 |
| `--color-2-transparent` | #ff5a0033 |
| `--color-3` | #87d8f5 |
| `--color-3-transparent` | #87d8f533 |
| `--color-4` | #ffed9b |
| `--color-4-transparent` | #ffed9b33 |
| `--neutral-1` | #ffffff |
| `--neutral-1-transparent` | #ffffff33 |
| `--neutral-2` | #fbfbfc |
| `--neutral-2-transparent` | #fbfbfc33 |
| `--neutral-3` | #f3f4f6 |
| `--neutral-3-transparent` | #f3f4f633 |
| `--neutral-4` | #e5e7eb |
| `--neutral-4-transparent` | #e5e7eb33 |
| `--neutral-5` | #c8ced5 |
| `--neutral-5-transparent` | #c8ced533 |
| `--neutral-6` | #9ca2a9 |
| `--neutral-6-transparent` | #9ca2a933 |
| `--neutral-7` | #787e84 |
| `--neutral-7-transparent` | #787e8433 |
| `--neutral-8` | #51565c |
| `--neutral-8-transparent` | #51565c33 |
| `--neutral-9` | #2f3439 |
| `--neutral-9-transparent` | #2f343933 |
| `--neutral-10` | #000000 |
| `--neutral-10-transparent` | #00000033 |
| `--success` | #00906c |
| `--success-transparent` | #00906c33 |
| `--warning` | #ffea00 |
| `--warning-transparent` | #ffea0033 |
| `--error` | #fc032d |
| `--error-transparent` | #fc032d33 |
| `--shadow-none` | none |
| `--shadow-s` | 0px 2px 4px 0px #00000000 |
| `--shadow-m` | 0px 2px 6px 0px #0000000d, 0px 8px 24px 0px #00000013 |
| `--shadow-l` | 0px 16px 48px 0px #00000000 |
| `--cte-canvas` | #ffffff |
| `--cte-surface` | #fbfbfc |
| `--cte-surface-muted` | #f3f4f6 |
| `--cte-text` | #000000 |
| `--cte-text-muted` | #787e84 |
| `--cte-border` | #e5e7eb33 |
| `--cte-accent` | #07376b |
| `--cte-accent-text` | #fbfbfc |
| `--cte-danger` | #fc032d |
| `--cte-focus` | #07376b |
| `--cte-font` | "Timeless Grotesk", sans-serif |
| `--cte-font-size` | 12px |
| `--cte-font-weight` | 400 |
| `--cte-line-height` | 17px |
| `--cte-letter-spacing` | 0.01em |
| `--cte-detail-font-size` | 10px |
| `--cte-detail-line-height` | 14px |
| `--cte-detail-letter-spacing` | 0.01em |

## dark CSS variables

Define these in the app’s existing theme scope for this mode. Keep component styles linked to the variables.

| Variable | Value |
| --- | --- |
| `--theme-name` | Untitled |
| `--theme-icon-family` | Lucide |
| `--theme-icon-style` | outlined |
| `--toolbar-divider-bleed` | 0 |
| `--focus-ring-outline` | initial |
| `--icon-stroke-width` | 2 |
| `--icon-light-display` | none |
| `--icon-regular-display` | inline |
| `--icon-bold-display` | none |
| `--motion-duration` | 200ms |
| `--motion-easing` | cubic-bezier(0.16, 1, 0.3, 1) |
| `--motion-type` | easing |
| `--motion-visual-duration` | 0.2 |
| `--motion-bounce` | 0.2 |
| `--motion-enabled` | 1 |
| `--motion-small-iterations` | infinite |
| `--motion-large-duration` | 360ms |
| `--motion-large-easing` | cubic-bezier(0.22, 1, 0.36, 1) |
| `--motion-large-type` | easing |
| `--motion-large-visual-duration` | 0.36 |
| `--motion-large-bounce` | 0.2 |
| `--motion-large-iterations` | infinite |
| `--motion-popup-scale` | 0.96 |
| `--motion-press-distance` | 1px |
| `--option-badge-background` | #393e43 |
| `--option-badge-foreground` | #ffffff |
| `--navigation-active-foreground` | #ffffff |
| `--emphasis-chart-fill` | #07376b33 |
| `--emphasis-balance-background` | #52575d |
| `--emphasis-rewards-background` | #272b31 |
| `--emphasis-icon-background` | #272b31 |
| `--emphasis-icon-foreground` | #ffffff |
| `--emphasis-type-background` | #272b31 |
| `--emphasis-type-foreground` | #ffffff |
| `--navigation-active-background` | #393e43 |
| `--surface-raised-image` | none |
| `--surface-raised-shadow` | 0 0 0 0 transparent |
| `--surface-recessed-image` | none |
| `--surface-recessed-shadow` | 0 0 0 0 transparent |
| `--space-zero` | 0px |
| `--space-xxs` | 3px |
| `--space-xs` | 5px |
| `--space-s` | 8px |
| `--space-m` | 10px |
| `--space-l` | 15px |
| `--space-xl` | 20px |
| `--space-xxl` | 31px |
| `--tracking-xs` | -0.02em |
| `--tracking-s` | -0.01em |
| `--tracking-m` | 0em |
| `--tracking-l` | 0.01em |
| `--tracking-xl` | 0.02em |
| `--size-xxs` | 9px |
| `--line-xxs` | 12px |
| `--letter-spacing-xxs` | 0.02em |
| `--size-xs` | 10px |
| `--line-xs` | 14px |
| `--letter-spacing-xs` | 0.01em |
| `--size-s` | 12px |
| `--line-s` | 17px |
| `--letter-spacing-s` | 0.01em |
| `--size-m` | 14px |
| `--line-m` | 20px |
| `--letter-spacing-m` | 0em |
| `--size-l` | 20px |
| `--line-l` | 27px |
| `--letter-spacing-l` | -0.01em |
| `--size-xl` | 31px |
| `--line-xl` | 34px |
| `--letter-spacing-xl` | -0.01em |
| `--size-xxl` | 41px |
| `--line-xxl` | 44px |
| `--letter-spacing-xxl` | -0.02em |
| `--radius-zero` | 0px |
| `--radius-xs` | 2px |
| `--radius-s` | 4px |
| `--radius-m` | 8px |
| `--radius-l` | 12px |
| `--radius-xl` | 20px |
| `--radius-full` | 9999px |
| `--border-none` | 0px |
| `--border-s` | 0px |
| `--border-m` | 0px |
| `--border-l` | 0px |
| `--border-default-color` | #393e4333 |
| `--border-shadow-none` | 0 0 0 0 transparent |
| `--border-shadow-s` | 0 0 0 0 transparent |
| `--border-shadow-m` | 0 0 0 0 transparent |
| `--border-shadow-l` | 0 0 0 0 transparent |
| `--font-ui` | "Timeless Grotesk", sans-serif |
| `--weight-ui-regular` | 400 |
| `--weight-ui-medium` | 500 |
| `--weight-ui-heavy` | 600 |
| `--font-brand` | "Timeless Grotesk", sans-serif |
| `--weight-brand-regular` | 400 |
| `--weight-brand-medium` | 500 |
| `--weight-brand-heavy` | 600 |
| `--font-editorial` | "Timeless Grotesk", sans-serif |
| `--weight-editorial-regular` | 400 |
| `--weight-editorial-medium` | 500 |
| `--weight-editorial-heavy` | 600 |
| `--font-data` | "Timeless Grotesk", sans-serif |
| `--weight-data-regular` | 400 |
| `--weight-data-medium` | 500 |
| `--weight-data-heavy` | 600 |
| `--color-none` | transparent |
| `--color-1` | #07376b |
| `--color-1-transparent` | #07376b33 |
| `--color-2` | #ff5a00 |
| `--color-2-transparent` | #ff5a0033 |
| `--color-3` | #87d8f5 |
| `--color-3-transparent` | #87d8f533 |
| `--color-4` | #ffed9b |
| `--color-4-transparent` | #ffed9b33 |
| `--neutral-1` | #000000 |
| `--neutral-1-transparent` | #00000033 |
| `--neutral-2` | #1c2026 |
| `--neutral-2-transparent` | #1c202633 |
| `--neutral-3` | #272b31 |
| `--neutral-3-transparent` | #272b3133 |
| `--neutral-4` | #393e43 |
| `--neutral-4-transparent` | #393e4333 |
| `--neutral-5` | #52575d |
| `--neutral-5-transparent` | #52575d33 |
| `--neutral-6` | #7e848a |
| `--neutral-6-transparent` | #7e848a33 |
| `--neutral-7` | #a6acb3 |
| `--neutral-7-transparent` | #a6acb333 |
| `--neutral-8` | #cad0d7 |
| `--neutral-8-transparent` | #cad0d733 |
| `--neutral-9` | #f3f4f6 |
| `--neutral-9-transparent` | #f3f4f633 |
| `--neutral-10` | #ffffff |
| `--neutral-10-transparent` | #ffffff33 |
| `--success` | #00906c |
| `--success-transparent` | #00906c33 |
| `--warning` | #ffea00 |
| `--warning-transparent` | #ffea0033 |
| `--error` | #fc032d |
| `--error-transparent` | #fc032d33 |
| `--shadow-none` | none |
| `--shadow-s` | 0px 2px 4px 0px #00000000 |
| `--shadow-m` | 0px 2px 6px 0px #0000000d, 0px 8px 24px 0px #00000013 |
| `--shadow-l` | 0px 16px 48px 0px #00000000 |
| `--cte-canvas` | #000000 |
| `--cte-surface` | #1c2026 |
| `--cte-surface-muted` | #272b31 |
| `--cte-text` | #ffffff |
| `--cte-text-muted` | #a6acb3 |
| `--cte-border` | #393e4333 |
| `--cte-accent` | #07376b |
| `--cte-accent-text` | #f3f4f6 |
| `--cte-danger` | #fc032d |
| `--cte-focus` | #07376b |
| `--cte-font` | "Timeless Grotesk", sans-serif |
| `--cte-font-size` | 12px |
| `--cte-font-weight` | 400 |
| `--cte-line-height` | 17px |
| `--cte-letter-spacing` | 0.01em |
| `--cte-detail-font-size` | 10px |
| `--cte-detail-line-height` | 14px |
| `--cte-detail-letter-spacing` | 0.01em |

## Authored component assignments

These are project edits. The [component reference](untitled-components.md) includes the effective assignments with defaults and shared parts resolved.

```json
{
  "componentTokens": {
    "button:ghost:rest": {
      "paddingX": "l",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "button:danger:rest": {
      "paddingX": "l",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "input:default:rest": {
      "paddingX": "m",
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "button:outline:rest": {
      "paddingX": "l",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "button:primary:rest": {
      "paddingX": "l",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "select:default:rest": {
      "paddingX": "m",
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "button:secondary:rest": {
      "paddingX": "l",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "combobox:default:rest": {
      "paddingX": "m",
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "menu:default:part:option:rest": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    },
    "slider:default:part:thumb:rest": {
      "controlSize": "l"
    },
    "slider:default:part:track:rest": {
      "controlSize": "xl"
    },
    "switch:default:part:control:rest": {
      "controlSize": "xl"
    },
    "combobox:default:part:option:rest": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    },
    "menu:default:part:option:selected": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    },
    "otp-field:default:part:input:rest": {
      "paddingX": "s",
      "paddingTop": "xs",
      "paddingLeft": "s",
      "paddingRight": "s",
      "paddingBottom": "xs"
    },
    "checkbox:default:part:control:rest": {
      "controlSize": "l"
    },
    "autocomplete:default:part:input:rest": {
      "paddingX": "s",
      "paddingTop": "s",
      "paddingLeft": "s",
      "paddingRight": "s",
      "paddingBottom": "s"
    },
    "autocomplete:default:part:option:rest": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    },
    "combobox:default:part:option:selected": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    },
    "autocomplete:default:part:popover:rest": {
      "radius": "s"
    },
    "autocomplete:default:part:option:selected": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    }
  },
  "componentVariants": {}
}
```
