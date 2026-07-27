# Collaboration routing milestone

This milestone adds universal room-level routing and compact collaboration controls
to Claudian. It contains no vault-specific paths, account names, or project logic.

## Delivered

- deterministic automatic routing between round table, parallel, deliberation, and
  mentioned-only delivery;
- configurable round-table order, starter, one to five cycles, and rotating starters;
- selectable deliberation synthesizer and persisted facilitator metadata;
- direct Active, Preserve, and Muted participant controls;
- route previews, projected turn counts, persisted effective-route summaries, and
  round-table cycle labels;
- cycle-boundary queue locking and stop-on-failure/conflict behavior;
- portable collaboration schema version 2 with version 1 compatibility and runtime
  validation;
- compact and responsive sidebar controls informed by narrow-pane UI review.

See [COLLABORATION-ROUTING.md](COLLABORATION-ROUTING.md) for behavior and user-facing
details.

## Validation

- TypeScript typecheck, lint, production build, syntax, release-version, architecture,
  and Obsidian DOM-helper checks passed.
- All 1,949 chat-feature tests passed.
- The expanded changed-surface suite passed 161 tests.
- Collaboration plus the complete chat suite passed 2,066 tests with open-handle
  detection.
- A DOM-level regression covers grouped participant controls, the explicit resource
  state menu, state selection, and automatic route preview.
- Portable import tests cover invalid modes and legacy machine-local unavailability.

The repository-wide `npm test -- --runInBand` command did not terminate within seven
minutes in the Windows development environment. Bounded suites completed. The full
core sweep passed 669 tests and encountered four existing symlink-creation `EPERM`
failures.

## Known follow-ups

- Facilitator selection is validated and persisted as route metadata. Agent-assisted
  prompt relay is not enabled yet; it needs typed output, source-prompt preservation,
  and visible pre-dispatch review.
- Quick participant-state changes do not yet provide an undo toast.
- The production bundle is 3,471,546 bytes. The branch baseline was already 30,895
  bytes above the 3,425,000-byte startup budget; this milestone adds 15,651 bytes.
- A final live visual pass should be performed in Obsidian after loading the build in
  a clean vault.
