# Local validation

Validated on 28–30 October 2026 with Obsidian 1.14.5 on macOS, plugin 0.1.0,
and the bundled 1Password JavaScript SDK 0.5.0.

## Automated checks

- Clean `npm ci`, TypeScript checking, and zero-warning Obsidian ESLint checks.
- 74 passing Node tests: authenticated encryption, strict parsing, secret/reference
  handling, settings normalization, serialized saves, conflicts, encrypted recovery,
  shutdown, renames, permanent decryption, native lifecycle regressions, write and
  recovery guards, and release metadata/Conventional Commits.
- Reconnection regressions cover a cached client failing when 1Password quits,
  fresh connections on explicit retry, failed reauthorization, vault-list failures,
  no automatic replay of item creation, overlapping old/new requests, disposal,
  error redaction, and clearing the dialog's old error during retry/cancellation.
- Guided setup regressions cover acknowledgement/account gating, a vault-list
  request before advancement, empty vaults, retry/cancellation, Back and account
  changes, mandatory secret readback, mismatched passwords, uncertain creation,
  and settings indexing without SDK calls.
- Command regressions cover the four stable IDs and contextual visibility,
  palette/popout context, execution-time target checks, cancellation before file
  loading or authorization completes, explicit plaintext confirmation, and no
  success notices after failed saves. Command checks perform no SDK calls or I/O.
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
- All four current command IDs were registered in the running app; the individual
  Lock and Unlock commands are no longer registered.

## Installed reconnect fix

- Installed the updated three assets in the personal Notes vault after backing up
  the prior installation outside the vault, then reloaded only Protected Notes.
- Confirmed that the existing protected note unlocked through 1Password and the
  unlock dialog closed. Account/reference settings and the enabled-plugin list
  were unchanged; installed asset hashes match the validated production build.
- The quit/reopen failure and explicit retry paths are covered by the automated
  provider regressions described above.

## Guided setup checks

- Seven synthetic-provider checks passed in the real Obsidian app: initial
  acknowledgement gating, keyboard Tab/Space navigation, connection and heading
  focus, Back/retry guidance, empty vaults, a 430 × 780 layout with visible action
  buttons, and cancellation of a pending connection. Run with
  `node scripts/obsidian-qa.mjs setup` against the disposable profile.
- A separate connection through the real 1Password SDK successfully listed vaults
  and advanced to secret selection. The dialog was then cancelled; this check
  created no item and saved no settings.
- Updated the installed Notes-vault assets after an external backup and reloaded
  the plugin. Existing settings and recovery files were preserved.

## Simplified workflow checks

- Re-ran the ten synthetic-provider persistence scenarios and seven guided-setup
  scenarios with the new labels in a fresh disposable vault.
- Nine additional real-app workflow checks passed: contextual command discovery,
  Protect/Open/Cancel, Source/Live Preview/Reading and command-palette focus,
  encrypted saves and command targeting in a popout, automatic multi-pane
  clearing, the global privacy command, pending authorization cancellation,
  immediate last-pane-close persistence, and explicit removal confirmation.
- Run `node scripts/obsidian-qa.mjs workflow` against the disposable profile to
  reproduce the simplified workflow checks. Its passwords and contents are
  synthetic; it does not authorize or mutate a real 1Password item.
- Local Notes delivery verified the updated asset hashes and enabled state after
  plugin reload, with settings, existing recovery, and hotkey configuration
  preserved. Full workflow checks were performed in the disposable vault.

## Limits

Windows and Linux have not had live app validation. Other installed plugins and
malicious direct filesystem access are not isolated. Historical plaintext backups,
external attachments, OS memory paging, and forensic RAM erasure are outside the
plugin's guarantees. See README.md for operational boundaries and setup.

These validation checks did not create a public release.
