# Collaboration routing

Collaboration rooms can route each user turn manually or choose a mode from the
prompt. Routing settings are stored with the room and included in version 2 portable
room exports.

## Modes

| Mode | Behavior |
| --- | --- |
| Round table | Participants run sequentially and later participants see earlier responses. |
| Parallel | Participants receive the first-pass prompt together. |
| Deliberation | Positions, critique, synthesis, and ratification run as explicit phases. |
| Mentions | Only explicitly selected or mentioned participants receive the turn. |
| Auto | Deterministic prompt signals select one of the modes above. |

Explicit recipients take precedence over automatic selection. Shared writable file
references use round-table delivery when more than one participant is addressed.
The composer shows an estimated route and projected turn count; the persisted
timeline event records the effective route actually used.

## Round-table controls

Open **Configure** in the collaboration control rail to set:

- participant order;
- starting participant;
- one to five complete cycles;
- fixed or rotating cycle starters;
- facilitator selection and the deliberation synthesizer role.

The room roster order remains stable. Delivery order is derived separately so
changing the starter does not change participant colors or identity.

Later cycles ask participants to refine, challenge, or converge on the original
request using the previous cycle as context. A failed, cancelled, or conflicting
delivery stops the remaining cycles.

The synthesizer selection is applied by deliberation. Facilitator selection is
validated and recorded on the effective route so a later agent-assisted relay can
use it without changing the room schema; this milestone does not silently rewrite
the user's prompt through that participant.

## Participant routing states

Click a participant's usage/state segment in the collaboration rail:

- **Active** receives group, automatic, and explicit turns.
- **Preserve** is excluded from ordinary group and automatic turns but can be
  explicitly mentioned.
- **Muted** receives no turns until re-enabled.
- **Unavailable** is provider health state and cannot be set or cleared manually.

Usage details remain available from the same menu. Muted and unavailable
participants cannot be assigned as work-queue owners or reviewers.

## Portability

Portable schema version 2 adds routing settings. The importer continues accepting
version 1 packages and supplies safe defaults. Participant IDs and role references
are normalized against current room membership on update.
