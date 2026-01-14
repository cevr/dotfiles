# Cantor #2 Settings

## Current Issue
Random USB disconnections.

## Debugging Log

| Date | Time | Duration Before Disconnect | Notes |
|------|------|---------------------------|-------|
| | | | |

## Hardware Tested
- [ ] Different USB cable
- [ ] Direct port (no hub)
- [ ] TRRS cable between halves
- [ ] Powered USB hub

## System Log Commands
```bash
# Stream USB events
log stream --predicate 'eventMessage contains "USB"' --info

# Search recent USB events
log show --last 1h --predicate 'eventMessage contains "USB"'
```
