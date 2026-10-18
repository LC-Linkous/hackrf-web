<!-- One logical change per PR, please. -->

## Summary

Closes #

## What this touches

- [ ] Driver (`ShellLink` / `SerialLink`) — framing, parsing, timing
- [ ] Views / plotting
- [ ] Markers / math (SWR, Z, Smith)
- [ ] Export
- [ ] Demo device
- [ ] Model envelopes (`MODELS`)
- [ ] Docs / PROTOCOL.md / CHANGELOG

## How it was tested

- [ ] Demo mode: connect → single sweep → each view → markers → each export → diagnostics → disconnect
- [ ] Light **and** dark mode checked (plot changes)
- [ ] Real device — model and `version` reply:
- [ ] If the driver changed: ran *Collect diagnostic sample* before and after and compared

## Checklist

- [ ] No new literal colours — everything from the CSS variables
- [ ] No new dependencies (single self-contained file)
- [ ] If a device quirk was found: added to PROTOCOL.md *Quirks*
- [ ] CHANGELOG.md updated

## Notes for reviewers
