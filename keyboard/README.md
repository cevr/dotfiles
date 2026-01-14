# Keyboard Configuration

Configuration for Cantor split keyboards with Vial/QMK firmware.

## Keyboards

### Cantor #1 (Primary)
- **Issue**: Mod-tap timing causes letter jumbling during fast typing
- **Config**: `cantor-1/`

### Cantor #2 (Secondary)
- **Issue**: Random USB disconnections
- **Config**: `cantor-2/`

## Home Row Mods Layout

```
Left hand:  A=Ctrl  S=Alt  D=Option  F=Meta
Right hand: J=Meta  K=Option  L=Alt  ;=Ctrl
```

## Tools

See [vial-utils](https://github.com/cvr/vial-utils) for CLI tools:
- `bun run vial` - read/write keyboard settings
- `bun run calibrate` - measure typing patterns for optimal tapping term

## Vial Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| Tapping Term | 200ms | Hold duration before modifier activates |
| Permissive Hold | Off | If ON, any key during hold triggers modifier |
| Ignore Mod Tap Interrupt | Off | Helps with fast rolling when ON |
| Retro Tapping | Off | Tap on release if held past term |
