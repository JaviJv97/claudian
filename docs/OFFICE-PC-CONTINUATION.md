# Office PC continuation

## Collaboration UI redesign handoff

The transcript-backed UI research, filesystem coverage audit, screenshot critique,
proposed information architecture, and prioritized implementation plan are in
[COLLABORATION-UI-RESEARCH.md](./COLLABORATION-UI-RESEARCH.md).

Resume the UI milestone from that document before making further layout changes.

This branch supports a safe room handoff between computers without copying
provider credentials or treating machine-local provider session IDs as
Claudian conversation IDs.

## Install on Windows

1. Download `release/claudian-windows-2.0.41-portable.zip` from the
   `feat/shared-collaboration-rooms` branch and verify it against
   `release/SHA256SUMS`.
2. Extract `main.js`, `manifest.json`, and `styles.css` into:

   ```text
   <vault>\.obsidian\plugins\realclaudian\
   ```

3. Open Obsidian, enable Claudian under **Settings → Community plugins**, and
   configure the Windows-local Claude Personal, Claude Company, and Codex
   runtimes.
4. Copy the portable room JSON into:

   ```text
   <vault>\.claudian\portable-rooms\
   ```

5. Run **Claudian: Import latest portable collaboration room** from the Obsidian
   command palette.

The import creates new local conversations for every participant, restores the
visible timeline and work queues, and leaves provider authentication on the
Windows computer.

## Path remapping

Portable exports list absolute Linux or Windows paths found in historical room
messages as `machineLocalReferences`. They remain visible as historical
evidence but are not executed or rewritten automatically.

Before allowing an imported room to perform work, map the relevant logical
locations:

| Logical content | Windows location example |
| --- | --- |
| Obsidian vault | `C:\Users\<you>\Documents\Obsidian-Collaboration-Test` |
| Highlander repository | `C:\Work\highlander` |
| Claudian repository | `C:\Work\claudian` |
| Conversation archive | `C:\Work\conversation-archive` |
| Research operations | `C:\Work\research-operations` |

## Safety boundary

- Portable rooms do not contain account credentials, cookies, API keys,
  provider-native session IDs, quota telemetry, or embedded attachment bytes.
- Imported participants start fresh Windows-local provider sessions. Claudian
  supplies the restored shared timeline as continuation context.
- In-flight operations are not resumed. Review the last completed room event
  and work-queue state before starting another task.
- Customer photos, contact sheets, audio, and other local-only evidence must be
  transferred through an approved private channel; do not commit them merely
  to make a room portable.

## Verification

After import:

1. Confirm the footer names all expected participants.
2. Send a read-only prompt to every participant.
3. Send a second prompt while the first is active and confirm it queues.
4. Restart Obsidian.
5. Confirm the room roster, timeline, and work queue remain present.
6. Only then authorize local, reversible project work.
