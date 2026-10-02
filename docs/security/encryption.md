# Encryption at rest and app lock

Arcalo 1.10 can encrypt its database and lock its windows behind a PIN. Both are **off by
default**; they are offered in the first-run setup (step „Sicherheit“) and under
Settings → Daten & Sicherheit → Sicherheit.

## What is encrypted, and what is not

| Data | Encrypted? |
| --- | --- |
| `workspace.db` (notes, tasks, time entries, settings, chats, versions, trash) and its WAL | yes – SQLCipher 4, AES-256, one random 256-bit key |
| New backups (`backups/arcalo-*.db`, local and copied to destinations) | yes – the same key (see below) |
| Pre-update backups and restore safety copies made after encrypting | yes – they are `VACUUM INTO` copies or renamed database files |
| Backups made **before** encrypting | no – Settings → Sicherheit counts the local ones and offers „Unverschlüsselte löschen“; copies in destinations stay until they rotate out |
| Markdown mirror and Git sync | **no** – readable `.md` files by design. The mirror's switch and a link to its settings sit next to the encryption switch |
| Attachments (`attachments/`: images, PDFs, drawings, voice recordings) | **no** – normal files. Encrypting them would break opening them in other programs and the attachment copies; use full-disk encryption if they are sensitive |
| `settings.json` of the Git settings sync, the developer log, the diagnostic package | no (no note content; the log redacts secrets) |
| The key itself | in the OS credential store (below), never in the database or the logs |

## Key storage per platform

The key comes from the OS random generator, is stored as hex under the service name `Annalo`,
account `db-key` (portable copies: `db-key@<folder id>`), and is read back before anything is
encrypted.

- **Windows**: Credential Manager (per user).
- **macOS**: login keychain (per user).
- **Linux**: Secret Service (GNOME Keyring, KWallet, KeePassXC). Without one (headless, no
  keyring, `ANNALO_SECRET_STORE=file`) the key goes into `secrets.json` in the data folder with
  mode 0600, and the settings warn: the encryption then still protects copies and backups of the
  database, but not against anyone who can read your user's files, because the key lies next to
  the database.

An encrypted file is opened with `PRAGMA key = "x'…'"` (a raw key, no slow key derivation at the
start). Whether a file is encrypted is read from the file itself: a plain SQLite file starts with
`SQLite format 3\0`; anything else made of whole pages counts as encrypted. A damaged file that is
not whole pages counts as plain, so the normal start-up recovery (restore a backup) runs.

## Switching on and off

„Datenbank verschlüsseln“ shows what is and is not covered, then the recovery key (print, save as
file, copy) and requires „Ich habe den Wiederherstellungsschlüssel gesichert“. Arcalo then
restarts (the close-and-restart path of updates and restores) and, before the database is opened:

1. exports it with `sqlcipher_export` into `workspace.db.cipher-new` (schema version carried over);
2. verifies the copy: `PRAGMA integrity_check` is `ok`, the same tables with the same row count
   each, the same schema version, the expected encryption state;
3. swaps it in by two renames (`workspace.db` → `workspace.db.cipher-old`, new → `workspace.db`);
4. opens it. The previous file stays until the **next** successful start and is then overwritten
   with zeros and deleted (or at once with „Jetzt sicher löschen“).

Every step is recorded in `cipher-migration.json` (written atomically, synced). A crash before
step 3 leaves the original untouched (the request is repeated or rolled back); a crash between
the two renames is finished at the next start. The unit tests stop the switch at every step
(`crates/annalo-core/src/cipher/tests.rs`). „Entschlüsseln“ works the same way in reverse. The key
stays in the credential store afterwards so older encrypted backups stay readable; encrypting
again reuses it.

**Secure deletion is best effort.** SSDs (wear levelling, TRIM), copy-on-write file systems (APFS,
Btrfs, ZFS), snapshots (Time Machine local snapshots, Volume Shadow Copies) and earlier backups of
the disk can keep the old plaintext blocks. Only full-disk encryption (BitLocker, FileVault, LUKS)
covers that.

## Recovery key

The recovery key is the database key itself in RFC 4648 base32 (A–Z, 2–7) with a 3-byte checksum:
56 characters in 14 groups of four (`ABCD-EFGH-…`). Lower case, spaces and the look-alikes 0, 1, 8
(read as O, I, B) are accepted; a typo is caught by the checksum instead of being taken for
another key. Settings → Sicherheit shows it again while the key is stored.

When the credential is missing (new laptop, restored disk image, portable copy on another
computer) or does not open the file (a backup restored with an older key, a damaged file), Arcalo
shows a recovery screen instead of the app, before anything else runs (no backups, sync or
schedulers): „Mit Wiederherstellungsschlüssel öffnen“ (or the password, below), „Auf diesem Rechner
merken“ (stores the key in this computer's credential store; off by default in portable mode, the
key is then handed to the next start through a 0600 file that is read once and deleted), „Letzte
Sicherung wiederherstellen“ when the key does not fit, the data folder, and Quit.

**Without the key and the recovery key the data cannot be opened – not by Arcalo, not by anyone.**
The command-line tool reads an encrypted workspace with `ARCALO_RECOVERY_KEY=<code>`.

### Password-protected key (portable mode)

The credential store is per computer, so a portable stick opens elsewhere only with the recovery
key. „Schlüssel mit Passwort schützen“ additionally stores the key wrapped with a password in the
data folder (`db-key.wrapped.json`: Argon2id with 64 MiB and 3 passes, AES-256-GCM, random salt
and nonce). On a computer without the key the recovery screen then asks for the password. The
password has at least 10 characters; a forgotten one cannot be recovered (the recovery key keeps
working). The file is useless without the password but allows offline guessing: choose a long
passphrase.

## Backups

Decision: backups of an encrypted database are **encrypted SQLite copies with the same key**
(`VACUUM INTO` under SQLCipher writes the target with the source's key). No separate backup key and
no wrapper format: a backup restores with the recovery key alone, the `.sha256` checksums and the
copies to destinations work on bytes and are unchanged, and the restore (Settings → Sicherung, the
start-up recovery) checks a backup with `PRAGMA quick_check` using the key. If the key is missing
after a restore, the recovery screen asks for the recovery key.

Restoring a backup made before encrypting makes the workspace plaintext again (the file says what
it is); Settings → Sicherheit then shows „Nicht verschlüsselt“.

## App lock

Settings → Sicherheit → App-Sperre: Aus / Beim Start / Beim Start und bei Inaktivität (1–240
minutes without keyboard or mouse input on the computer), „Nach dem Ruhezustand sperren“, and
Windows Hello or Touch ID as an option. The configuration lives in the workspace (`meta.applock`,
not in the settings model), the PIN only as an Argon2id hash (19 MiB, 2 passes, random salt, PHC
string) in the credential store (account `app-lock-pin`), never in plain text.

While locked:

- the main window shows the lock screen; the app behind it is **unmounted** (no note content in
  the page), and the backend refuses every app command except the lock screen's own;
- quick capture and quick search do not open: their shortcuts bring up the lock screen; global
  shortcuts, jump-list entries and notification buttons do the same;
- the tray menu shows only „Entsperren“ and „Beenden“; its tooltip says „Arcalo – gesperrt“ (no
  timer, task or recording);
- notifications are shown without content and without buttons.

Wrong PINs: three free attempts, then 5 s, doubling up to 15 minutes. The count is kept in the
workspace, so a restart does not reset it.

Sleep is detected by a jump of the clock between two checks (every 5 s). Locking the screen itself
is **not** detected (that needs a session listener per platform); combine the idle time with the
system's screen lock.

### Forgotten PIN

There is no PIN recovery. „PIN vergessen?“ on the lock screen switches the lock off (and deletes
the PIN) after

- the system sign-in: Windows Hello (`UserConsentVerifier`, for the main window), or on macOS
  Touch ID or the account password (`LocalAuthentication`, `DeviceOwnerAuthentication`); or
- the recovery key, when the database is encrypted.

On Linux without an encrypted database neither exists. Quit Arcalo and remove the lock by hand:
`sqlite3 workspace.db "DELETE FROM settings WHERE key LIKE 'meta.applock%'"` – anyone who can do
this can also read the unencrypted database; the lock never protected more than the open app.

### Limits

- The app lock is a privacy screen for the running app, not encryption: with an unencrypted
  database the data is readable on disk regardless of the lock.
- Windows Hello and Touch ID are compile-checked in CI only; they are on the manual checklist of
  the release notes.
- Debug builds have a test seam (`applock_test_idle`) that release builds refuse.
