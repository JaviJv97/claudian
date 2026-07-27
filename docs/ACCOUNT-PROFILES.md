# Account profile identity

Claudian ships stable logical roles for collaboration:

| Role | Default Claude config directory |
| --- | --- |
| `personal` | `~/.claude-personal` |
| `company` | `~/.claude` |

These defaults are part of the repository and therefore travel with GitHub
releases on Windows and Linux. A device may override the directories in
Claudian settings, but it must not exchange the role IDs or infer identity from
the display labels.

Credentials remain in Claude's own config directories and are never copied
into a vault or release.

## Usage provenance

Claude quota snapshots carry the runtime profile ID and a non-secret SHA-256
fingerprint of the profile ID, platform, and resolved config directory.
Claudian accepts a quota refresh only if the room participant, conversation,
tab, runtime instance, profile ID, and returned snapshot still agree after the
provider request completes.

If any binding changes during refresh, the result is discarded. Missing or
unverified account state is displayed as unavailable instead of being shown
under another account's label.

## New device checklist

1. Authenticate the Personal account in `~/.claude-personal`.
2. Authenticate the Company account in `~/.claude`, or update the Company
   profile to the device's actual config directory.
3. Open Claudian settings and confirm both profile directories report `Ready`.
4. Create a collaboration room and refresh each participant's quota.
5. Confirm the displayed profile and expected account usage before authorizing
   autonomous routing.

No credential files or quota snapshots should be committed to Git.

