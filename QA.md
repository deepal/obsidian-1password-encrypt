# Local validation

Validated on 28 October 2026 with Obsidian 1.14.5 on macOS, plugin 0.1.0,
and the bundled 1Password JavaScript SDK 0.5.0.

## Automated checks

- Clean `npm ci`, TypeScript checking, and zero-warning Obsidian ESLint checks.
- 44 passing Node tests: authenticated encryption, strict parsing, secret/reference
  handling, settings normalization, serialized saves, conflicts, encrypted recovery,
  shutdown, renames, permanent decryption, native lifecycle regressions, write and
  recovery guards, and release metadata/Conventional Commits.
- Reconnection regressions cover a cached client failing when 1Password quits,
  fresh connections on explicit retry, failed reauthorization, vault-list failures,
  no automatic replay of item creation, overlapping old/new requests, disposal,
  error redaction, and clearing the dialog's old error during retry/cancellation.
- Production build and both the project artifact validator and the Obsidian plugin
  skill's artifact checker passed. The standard three files include all SDK WASM
  and its license notice; no runtime installation or external WASM is needed.
- Runtime dependency audit: no known findings. The full development-tool audit
  reports two findings in dependencies bundled inside semantic-release's npm
  dependency. `npm audit fix` cannot replace those bundled packages. They are not
  included in the Obsidian plugin bundle.

## Live Obsidian checks

Feature validation used a separate disposable vault and Electron profile. The
subsequent personal-vault installation check is recorded below.

- Ten synthetic-provider smoke scenarios passed: in-place encryption, native editor
  unlock, encrypted saves, Source/Reading mode changes, split-pane locking, plaintext
  write rejection, rename/missing-settings recovery, simulated save failure,
  encrypted recovery restoration, and explicit permanent decryption.
- Real 1Password authorization, Password-item creation, and read-back verification
  passed. Renaming the test item preserved resolution by ID. The clearly labelled
  QA item remains in 1Password; no real existing secrets were used as test passwords.
- Eight real-secret app scenarios passed: native unlock, in-document properties,
  no plaintext markers in the vault/recovery, no global search result while the
  note remains unlocked, plugin reload with empty settings, immediate edit-and-close
  persistence, clearing native property caches on lock, and a final locked state.
- A separate popout window successfully displayed the unlocked native editor,
  synchronized an edit with the main pane, and cleared both panes when locked.
- A scan of 134 files in the disposable vault and profile found no copy of the
  actual test password. Plaintext-marker scans ran before entering those markers
  as search queries, since user-entered search history is intentionally persistent.
- All six command IDs were registered in the running app.

## Installed reconnect fix

- Installed the updated three assets in the personal Notes vault after backing up
  the prior installation outside the vault, then reloaded only Protected Notes.
- Confirmed that the existing protected note unlocked through 1Password and the
  unlock dialog closed. Account/reference settings and the enabled-plugin list
  were unchanged; installed asset hashes match the validated production build.
- The quit/reopen failure and explicit retry paths are covered by the automated
  provider regressions described above.

## Limits

Windows and Linux have not had live app validation. Other installed plugins and
malicious direct filesystem access are not isolated. Historical plaintext backups,
external attachments, OS memory paging, and forensic RAM erasure are outside the
plugin's guarantees. See README.md for operational boundaries and setup.

These validation checks did not create a public release.
