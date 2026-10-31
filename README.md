# 1password Encrypt

Encrypt selected Markdown notes in place using a password stored in 1Password.
The filename stays visible; the entire original document, including frontmatter,
is encrypted. Unlocking uses Obsidian's native Source, Live Preview, and Reading
views while the file on disk stays encrypted.

Desktop only. Requires Obsidian 1.14.5 or later and the installed 1Password desktop
app with a signed-in account. Mobile devices can sync the encrypted Markdown but
cannot unlock it with this plugin. macOS is the initial live-tested platform;
Windows/Linux require equivalent live validation before claiming support there.

## Install a local build

Build with the development commands below, then copy `main.js`, `manifest.json`,
and `styles.css` into `<vault>/.obsidian/plugins/1password-encrypt/`.
Enable **1password Encrypt** under **Settings → Community plugins**, then set up
1Password as described below. Begin with disposable notes.

If upgrading a local `protected-notes` installation, close Obsidian and rename
the plugin folder to `1password-encrypt`, keeping its `data.json` and `recovery/`
contents. Re-enable the plugin after reopening Obsidian and reassign command
hotkeys under the new plugin ID.

## Set up

1. In Obsidian, open **Settings → 1password Encrypt → Set up** or **Setup help**.
2. Follow the first screen: open **1Password → Settings → Developer**, enable
   **Integrate with 1Password SDKs**, and keep the desktop app running.
3. Check **I’ve enabled “Integrate with 1Password SDKs”**, enter your account name
   or ID, and click **Connect to 1Password**. Approve the request inside 1Password;
   it may identify the requesting application as Obsidian. The plugin lists vaults
   to verify the connection before showing the secret setup screen.
4. Choose an existing secret reference, or choose a vault and enter a new password
   and confirmation. Click **Save and verify**. The plugin retrieves the secret
   again before saving settings or encrypting any note. Your 1Password account
   password is never requested by this plugin.
5. Open a Markdown note and run **1password Encrypt: Protect this note**.

Use a long, unique note-encryption passphrase. New notes use the configured default
reference; already encrypted notes retain their own reference. Changing the default
does not rotate the passwords of existing notes.

Each setup visit starts with an unchecked confirmation and a new connection check.
Neither is stored in settings. **Back** clears password fields and requires another
connection check. After item creation has been attempted, the account is fixed to
avoid accidentally creating duplicate items; cancel and reopen to change accounts.
Connection failures keep your account entry and instructions visible for retry.

The setup wizard does not retry an uncertain item-creation operation. If creation
could not be confirmed, inspect 1Password for **1password Encrypt password**
and use its existing reference, instead of creating duplicates.

## Using protected notes

Protect a note once, then use **Open with 1Password** whenever you want to read or
edit it. Its contents hide automatically when you switch to another note or close
its last pane. Protection stays active while you work; there is no need to protect
the note again after editing.

Opening a protected note displays an **Open protected note** popup. Cancelling
leaves its contents hidden. Restored startup tabs show an **Open with 1Password**
button without opening multiple dialogs. 1Password controls authorization and may reuse a session until
ten minutes of inactivity or locking 1Password; a new biometric prompt is not
guaranteed for every note.

If a request fails after quitting 1Password, reopen 1Password and click **Open
with 1Password** again. Failed connections are discarded, so the next attempt
connects to the running app again. The previous error clears while authorization
is pending. Item-creation requests are never automatically replayed.

Desktop SDK authorization covers the entire selected 1Password account and is
granted to the Obsidian process. Only install plugins you trust in that process.

Source, Live Preview, Reading mode, tables, in-document properties, and normal
Markdown editing use the native editor. Saves and recovery copies contain only
ciphertext. The global content search, metadata cache, and hover/embedded previews
do not receive decrypted note content. In-note Find works while unlocked.

Switching to a different note locks all panes of the protected note you left.
Closing its last pane or explicitly locking also releases the session. There is
no inactivity timer, application-blur lock, or automatic lock of an already
decrypted note merely because 1Password locks. Switching Source/Live Preview/
Reading modes or opening the command palette does not lock it.

| Command | Purpose |
| --- | --- |
| Protect this note | Set up if necessary and protect the current ordinary Markdown note |
| Remove protection | Confirm and turn the current protected note back into ordinary Markdown |
| Lock all protected notes now | Immediately hide all readable protected content and cancel pending opening requests in this vault |
| Set up 1Password | Create a password or configure an existing reference |

Only commands that apply to the current state appear in the command palette.
Ordinary unprotected notes are unaffected by **Lock all protected notes now**.
Removing protection makes the note readable to search, sync, backups, and other
plugins; it always requires confirmation.

The individual **Lock current note** and **Unlock current note** commands have
been removed, so their old hotkeys no longer work. The Protect
(previously Encrypt), Remove protection, Lock all, and Setup commands retain their local
command IDs; migrating from the old plugin ID requires reassigning hotkeys as above.

## Recovery and reinstalling

Each envelope includes an `op://<vault-id>/<item-id>/[section-id/]<field-id>` secret
reference and an account selector. References are addresses, not passwords or
capability tokens. Anyone using them still needs authorization from 1Password.

Reinstalling the plugin does not require the old plugin settings: open an encrypted
note and use its embedded reference, or configure that reference manually. The
unlock dialog's **Locate an existing secret** section can correct an account or
reference. It must retrieve the same password value and successfully authenticate
the ciphertext before changing the reference. Uninstalling never deletes 1Password
items. Renaming/moving the Markdown file does not affect encryption.

Do not delete or change the password value in 1Password unless you have first removed
protection from every note using it. Keeping the same item ID with a different
password does not preserve decryption. Password rotation is not implemented in v1.

Unsaved edits are checkpointed as encrypted recovery envelopes under the plugin's
`recovery/` directory. After a save failure, the note can lock if the recovery copy
was successfully written. On reopening, choose to restore those edits, recover
as a separate encrypted note, or explicitly discard recovery. If the original
file changed externally, recovery must use a separate note. If both writes fail,
the plugin keeps the session available and asks you to retry or explicitly discard
the unsaved edits. A forced process termination or an unwritable device can still
lose unsaved work; keep backups of encrypted notes and your 1Password account.

## Security and privacy boundaries

- The note's whole original contents are encrypted with AES-256-GCM. Only its
  filename, encrypted size, routing reference, and cryptographic parameters are public.
- Passwords and derived keys are never deliberately persisted by the plugin:
  not in settings, logs, temporary files, or recovery. Decryption requires them
  briefly in RAM. Clearing buffers cannot promise forensic erasure of JavaScript
  strings, OS paging, or crash dumps. 1Password itself maintains encrypted local data.
- The native editor makes decrypted text accessible to trusted installed plugins.
  This is not a sandbox against malicious plugins, direct filesystem writes, or
  a compromised device. Plugins that export editor contents or send them to an AI
  provider remain your responsibility.
- Encrypting an existing note cannot erase earlier plaintext from Obsidian File
  Recovery, sync history, Git, backups, or other devices. Initial encryption first
  flushes ordinary unsaved Markdown edits, so they too may enter pre-encryption
  history. No historical backups are deleted automatically.
- Linked images, PDFs, and other attachments are not encrypted. Global metadata
  tools cannot inspect encrypted note properties and are prevented from writing
  plaintext properties around the protected envelope.
- The plugin uses version-sensitive native editor hooks. Unsupported required
  hooks leave the note locked; there is no plaintext fallback. Test app upgrades
  on disposable notes before using the build with important data.

## External access disclosures

This plugin requires a 1Password account and access to its desktop app. 1Password's
subscription terms apply; the plugin itself charges nothing. The official
`@1password/sdk` uses local IPC and 1Password's services to authenticate, create
the chosen Password item, and retrieve its field. Note text is encrypted locally
and is not sent to 1Password by this plugin. The plugin does not use analytics,
advertising, service-account tokens, clipboard-based password transfer, or a
separate CLI. It never installs or downloads runtime dependencies.

The bundled SDK and Node APIs access the installed 1Password integration outside
the vault. Encrypted recovery files stay inside the plugin's vault configuration
directory. The SDK is MIT-licensed; its source and security model are available at
[1Password SDK](https://github.com/1Password/onepassword-sdk-js) and
[desktop integration security](https://www.1password.dev/sdks/desktop-app-integrations).

## Development

```sh
npm ci
npm run lint
npm test
npm run typecheck
env -u OBSIDIAN_PLUGIN_DIR -u OBSIDIAN_VAULT_DIR npm run build
node scripts/check-artifacts.mjs
```

Build output is `main.js`, `manifest.json`, and `styles.css`. The pinned SDK's WASM
is embedded in the JavaScript bundle and compiled/instantiated asynchronously for
Electron. No `node_modules` folder or external WASM file is needed in the vault.
Set `OBSIDIAN_PLUGIN_DIR` or `OBSIDIAN_VAULT_DIR` explicitly for optional development
deployment. Verify only in a disposable vault before personal-vault installation.

`scripts/obsidian-qa.mjs` exercises the real app with a synthetic provider through
the development debugger. It refuses vaults whose names do not start with
`Protected Notes QA`. This verifies editor/persistence integration, independently
of a real authenticated 1Password test. Do not enable remote debugging for everyday
use or expose its port to the network.

Run `node scripts/obsidian-qa.mjs setup` against that disposable profile to check
the guided connection screen, real keyboard focus, retries, Back, cancellation,
and narrow layouts using a synthetic provider. Live 1Password authorization is
verified separately and remains under the user's control.

Run `node scripts/obsidian-qa.mjs workflow` in that disposable profile to verify
the four contextual commands, Protect/Open/Cancel, editor modes, popouts,
automatic hiding, pending-request cancellation, and removal confirmation with a
synthetic provider.

CI runs lint, tests, build, and artifact checks on pushes and pull requests.
After checks pass on `main`, semantic-release automatically publishes a GitHub
release when there are releasable Conventional Commits: `fix:` creates a patch,
`feat:` creates a minor, and `feat!:` or a `BREAKING CHANGE:` footer creates a
major release. Documentation, test, and CI-only commits do not create a release.
Without a previous release tag, the first releasable history produces `1.0.0`.

Release preparation updates the changelog, package/lockfile versions, manifest,
and compatibility history, then builds and validates the standard three assets.
Tags match the manifest version exactly, without a `v` prefix. The workflow
attests the published assets, downloads them, and verifies their bytes and
provenance. Release commits include `[skip ci]` to prevent a release loop.

The workflow uses the built-in `GITHUB_TOKEN`; no npm publishing or extra token
is needed. Pull requests only run checks. **CI and release** can also be run
manually on `main` to retry publishing; it skips publication if no release is due.
Use `npm run release:dry-run` with GitHub authentication to preview the next
version without changing files, tags, or releases.

See [FORMAT.md](FORMAT.md) for the recoverable v1 encryption format.
