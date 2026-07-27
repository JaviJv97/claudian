# Collaboration UI Research and Redesign Brief

Status: research complete; implementation not started  
Updated: 2026-07-27  
Branch: `feat/shared-collaboration-rooms`

## Purpose

This document preserves the UI research completed after configurable collaboration routing was implemented. It is the starting point for the next UI design and implementation milestone.

The current collaboration interface exposes the new behavior, but its information architecture does not yet make that behavior easy to understand. The redesign should answer one question before anything else:

> What will happen when I send this message?

## Current UI assessment

The latest inspected screenshots were:

- `C:\Users\Construction\Pictures\Screenshots\Screenshot 2026-07-27 164350.png`
- `C:\Users\Construction\Pictures\Screenshots\Screenshot 2026-07-27 164347.png`

The loaded UI is not the intended finished design.

Observed problems:

1. The participant rail is overcrowded. Claude Personal and Claude Company are squeezed into narrow compound controls while Codex wraps onto another row.
2. Recipient selection, connection status, stop controls, resource policy, and quota text compete inside each participant control.
3. Raw quota labels dominate or truncate despite being supporting information.
4. `Available` is ambiguous: it does not clearly mean selected recipients, agents eligible for automatic routing, or connected agents.
5. `3 agents` appears more than once and the purple count chip has no obvious operational meaning.
6. Five equally weighted route buttons make the area feel like a toolbar. The current route and the result of automatic routing are not prominent.
7. Usage Overview is visually detached from the participant state it explains.
8. Sender identity, recipient selection, and resource policy are separate concepts but are presented as if they were one control.
9. The interface consumes substantial vertical space while remaining difficult to scan.

## Local transcript coverage

The research inventory covered both mounted local filesystems, `C:` and `G:`.

### Primary YouTube transcript collections

- `C:\Users\Construction\yt-downloads\out`
- `C:\Users\Construction\yt-downloads\out.old`
- `C:\Users\Construction\yt-downloads\out.old\Dashboard and app ideas`
- `C:\Users\Construction\Downloads\Home-Claude-Data-Clone\Claude\corpora\raw-transcripts`
- `C:\Users\Construction\Downloads\Home-Claude-Data-Clone\Claude\corpora\ai-workflow-corpus`
- `C:\Users\Construction\ai-college-corpus`
- `C:\Users\Construction\construction-corpus`
- `G:\My Drive\YouTube Transcripts`

The `G:` collection matches the category structure and file counts of `yt-downloads\out.old`, including 223 files in `Dashboard and app ideas`. It is a synchronized mirror rather than an additional unidentified corpus.

A temporary 463-file `stack-research` transcript collection was also inventoried. It contains specialized stack/tutorial research and did not surface material that changes this collaboration UI direction.

Claude/Codex conversation archives, Highlander handoff logs, Alice Peschl interview records, package examples, and test fixtures were classified separately and were not treated as YouTube UI research.

### Most relevant local videos

- `EVERYTHING you need to know to build a Dashboard UI in 8 minutes (beginner friendly)`
- `Amateur vs Pro: Advanced UI Design with Replit Design & Gemini 3 Pro`
- `Build a Design System - Full Course`
- `Web / Desktop App UI Design in Figma - Full Course`
- `The $100K AI Design System Masterclass (Gemini 3)`
- `Open Design - Open Source Claude Design! Fully Free AI Design System!`
- `The FULL 2026 Guide To Layout & Composition For Designers!`
- `Claude Design 2 HOUR COURSE (Beginner to Pro)`
- `How to Avoid AI Slop in Vibe-Coded Landing Pages`
- `How I Vibe Code Beautiful $10,000 AI Dashboards (AntiGravity)`
- `How to Build a PREMIUM Hermes Agent Mission Control Dashboard`
- `How to Build a PREMIUM OpenClaw Mission Control Dashboard`
- `Building a Turo Host Dashboard with AI: Real-Time App Prototyping in Cursor`

Processed corpus cards also contributed:

- `construction-corpus/cards/raw-0525--dashboard-design-principles.md`
- `construction-corpus/cards/raw-1950--visual-hierarchy.md`

## Findings from the local corpus

### Persistent does not mean equally prominent

A sidebar is appropriate for persistent collaboration controls, but navigation and configuration should be visually muted so the current operational state remains primary.

### One surface needs one main purpose

The collaboration area should not behave like a general administration dashboard. Its primary purpose is to explain and control message routing. Detailed account usage and advanced route setup support that purpose but should not compete with it.

### Hierarchy must precede compactness

Shrinking the existing controls would preserve the confusion at a smaller size. Establish primary, secondary, and tertiary information first:

- Primary: selected/effective route and its execution summary.
- Secondary: sender and participant operational states.
- Tertiary: quota details, reset windows, and advanced configuration.

### Predictable spacing builds trust

Irregular wrapping, duplicated labels, and inconsistent control widths make a tool feel unfinished. A narrow sidebar needs stable full-width rows and a small spacing system.

### Details belong behind drill-downs

Expanded quota information, route parameters, account diagnostics, and rarely changed defaults should live in Usage, Configure, or participant menus.

### Semantic color must be consistent

The same state must use the same color everywhere. Color must not simultaneously mean agent identity, selection, availability, and quota health.

### Multi-agent systems need explicit identity and handoffs

The mission-control examples reinforce the value of permanent participant identity, current operational state, visible phase ownership, activity history, clear handoffs, and direct communication.

Those full dashboards are useful references for an expanded room view, but they are too dense to copy into the narrow composer sidebar.

### Every sidebar item must justify itself

Duplicate counts and labels that do not alter a decision should be removed.

## Recommended information architecture

The sidebar should have three layers:

1. Current routing state
2. Participants and sender
3. Collapsed configuration and usage detail

### Default compact state

```text
Collaboration Room                          Usage

AUTO · Round table
Personal → Company → Codex · 1 cycle
Auto chose round table for a multi-perspective planning request.
                                             Configure

Send as
Codex ▾

Participants
● Claude Personal       Active ▾        97%
● Claude Company        Reserve ▾       51%
● Codex                 Active ▾         1%
```

The effective route, speaking order, and cycle count form one sentence-like summary. This is the dominant element.

### Expanded routing configuration

```text
Routing
(●) Auto
( ) Mention only
( ) Parallel
( ) Round table
( ) Deliberation

Round table
First speaker       Claude Personal ▾
Order               Personal → Company → Codex
Cycles              −  1  +

User voice          Codex ▾
```

When Auto is enabled, the UI should show:

- The route Auto selected
- A short reason
- A per-message override
- Whether the override changes only this message or the room default

### Deliberation state

```text
Position → Critique → Synthesis → Ratification
Current phase: Critique
Synthesizer: Codex
```

The phase sequence is more useful than presenting Deliberation as only one of five static buttons.

## Participant state model

Use one operational state menu per participant:

- `Active`: eligible for automatic routing and direct messages.
- `Reserve`: excluded from automatic routing but manually mentionable.
- `Muted`: receives no collaboration messages.
- `Unavailable`: system-derived state for logged-out, missing, or inaccessible accounts.

`Reserve` matches the user's established language: sit out, bench, preserve usage, or hold an agent in reserve. It is meaningfully different from `Muted`.

Do not use `Preserve` as the visible state label. Preservation is the user's goal; `Reserve` describes the participant's actual operating state.

## Sender, recipients, and routing are separate

- `Send as`: which participant carries the user's voice into the collaboration.
- `Recipients`: which participants may receive the message.
- `Route`: how the selected participants interact.
- `Participant state`: whether an account is Active, Reserve, Muted, or Unavailable.

These concepts must not share one ambiguous control.

## Suggested design tokens

Use Obsidian variables where appropriate, with a minimal semantic layer for Claudian.

### Spacing

- `4px`: icon/text micro-gap
- `8px`: within-control gap
- `12px`: row padding or compact section gap
- `16px`: major section gap

### States

- Active: success/green
- Reserve: warning/amber
- Muted: neutral gray
- Unavailable/error: destructive/red
- Selected route: accent

Do not use these state colors as participant identity colors.

### Typography

- Route summary: primary emphasis
- Participant name and sender: secondary emphasis
- Quota and reset detail: tertiary emphasis

### Surfaces

- One collaboration surface
- Stable participant rows rather than separate heavy cards
- Subtle dividers or low-contrast row backgrounds
- Avoid nested borders unless they communicate an actual boundary

## Interaction and accessibility requirements

1. Routing modes are mutually exclusive and should use radio-group behavior.
2. Participant state selectors should be accessible menu buttons.
3. Advanced configuration should be an accessible disclosure.
4. Current state must not be communicated by color alone.
5. All icon-only controls require accessible names and tooltips.
6. Keyboard focus order should follow the visual hierarchy.
7. At narrow widths, rows should remain coherent rather than rearranging individual fields unpredictably.
8. Warn before high-cost fan-out, such as several agents over several round-table cycles.
9. Preserve the last explicit room configuration without obscuring the effective configuration chosen by Auto.

## Implementation priority

### P0 — Correct hierarchy and layout

1. Replace wrapping participant cards with stable full-width participant rows.
2. Separate sender selection from recipients.
3. Replace the five-button route grid with an effective-route summary and Configure disclosure.
4. Remove duplicate or unexplained agent-count UI.
5. Move detailed quota/reset information into Usage.

### P1 — Complete requested controls

1. Add Active, Reserve, and Muted controls to each sidebar participant.
2. Add first-speaker selection.
3. Add explicit round-table order.
4. Add cycle count.
5. Add user-voice/sender selection.

### P2 — Make Auto understandable

1. Show the effective route.
2. Show a concise selection reason.
3. Support per-message override.
4. Make default-changing behavior explicit.
5. Add high-cost route warnings.

### P3 — Deliberation and activity

1. Show phase progress.
2. Show synthesizer/owner.
3. Surface recent handoffs or activity in an expanded view.

### P4 — Verification

1. Responsive tests at narrow Obsidian sidebar widths.
2. Keyboard and ARIA tests.
3. Visual regression screenshots.
4. Light and dark theme checks.
5. Manual verification in every installed vault.

## Next-session starting point

The next thread should begin with a design pass, not implementation.

1. Re-open the latest screenshot beside this brief.
2. Produce two or three compact wireframe variants using the same content and width.
3. Select one information architecture.
4. Define the exact state transitions for sender, recipients, Reserve, Muted, and Auto override.
5. Only then edit `CollaborationTimeline.ts` and `styles.css`.
6. Verify the built plugin visually before deploying it to all vaults.

The governing principle is:

> Preserve persistent context in the sidebar, but expose only what is needed to understand and perform the next action.
