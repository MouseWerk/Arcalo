// Settings → Sicherheit, the lock screen and the recovery screen: typed commands and the small
// pieces of logic they share (tested in security.test.ts).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type LockMode = "off" | "start" | "idle";
export interface LockConfig {
  mode: LockMode;
  idle_minutes: number;
  on_sleep: boolean;
  os_auth: boolean;
}
export interface LockStatus {
  config: LockConfig;
  has_pin: boolean;
  locked: boolean;
  wait_secs: number;
  failures: number;
  os_auth: "windows_hello" | "touch_id" | null;
  encrypted: boolean;
  theme: string;
  lang: "de" | "en";
}
export interface UnlockReply {
  ok: boolean;
  wait_secs: number;
  failures: number;
}
export type FileState = "missing" | "plain" | "encrypted";
export interface CipherMigration {
  direction: "encrypt" | "decrypt" | "rekey";
  step: "requested" | "verified" | "swapped";
  requested: string;
  opens: number;
}
export interface CipherStatus {
  state: FileState;
  key_stored: boolean;
  store: string;
  store_file: boolean;
  portable: boolean;
  password: boolean;
  pending: CipherMigration | null;
  old_left: boolean;
  mirror: boolean;
  git_sync: boolean;
  plain_backups: number;
}
export type GateReason = "missing_key" | "wrong_key";
export interface GateStatus {
  reason: GateReason;
  password: boolean;
  portable: boolean;
  store: string;
  data_dir: string;
  backups: number;
  lang: "de" | "en";
}

/** What a command refused while locked answers. */
export const LOCKED_ERROR = "app-locked";

export const security = {
  lockStatus: () => invoke<LockStatus>("applock_status"),
  configureLock: (config: LockConfig, pin: string | null) => invoke<LockStatus>("applock_configure", { config, pin }),
  unlock: (pin: string) => invoke<UnlockReply>("applock_unlock", { pin }),
  unlockOs: () => invoke<boolean>("applock_unlock_os"),
  resetLock: (recovery: string | null) => invoke<void>("applock_reset", { recovery }),
  lockNow: () => invoke<void>("applock_lock_now"),
  lockFlushed: () => invoke<void>("applock_flushed"),
  showMain: () => invoke<void>("applock_show_main"),
  cipherStatus: () => invoke<CipherStatus>("cipher_status"),
  recoveryKey: (create: boolean) => invoke<string>("cipher_recovery_key", { create }),
  saveRecovery: (path: string, code: string) => invoke<void>("cipher_recovery_save", { path, code }),
  switchCipher: (encrypt: boolean) => invoke<void>("cipher_switch", { encrypt }),
  setPassword: (password: string | null) => invoke<void>("cipher_password", { password }),
  /** „Schlüssel wechseln“: a new key (its recovery key), then the change with a restart. */
  rekeyPrepare: () => invoke<string>("cipher_rekey_prepare"),
  rekey: (password: string | null) => invoke<void>("cipher_rekey", { password }),
  rekeyCancel: () => invoke<void>("cipher_rekey_cancel"),
  dropOld: () => invoke<void>("cipher_drop_old"),
  dropPlainBackups: () => invoke<number>("cipher_drop_plain_backups"),
  gateStatus: () => invoke<GateStatus>("keygate_status"),
  gateUnlock: (method: "recovery" | "password", secret: string, remember: boolean) => invoke<void>("keygate_unlock", { method, secret, remember }),
  gateQuit: () => invoke<void>("keygate_quit"),
  gateRestore: () => invoke<string>("keygate_restore"),
  gateOpenFolder: () => invoke<void>("keygate_open_folder"),
};

/**
 * A recovery key as typed: upper case, look-alikes read as the code's letters (0 → O, 1 → I,
 * 8 → B), groups of four joined by dashes. Same rules as the backend's parser.
 */
export function formatRecoveryInput(raw: string): string {
  const clean = raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/8/g, "B")
    .replace(/[^A-Z2-7]/g, "")
    .slice(0, 56);
  return clean.match(/.{1,4}/g)?.join("-") ?? "";
}

/** Whether a typed recovery key has all its characters (the checksum is checked by the backend). */
export const recoveryComplete = (code: string) => code.replace(/-/g, "").length === 56;

/** Seconds as „0:45“ or „2:05“ (the wait after wrong PINs). */
export function formatWait(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Whether a new PIN is usable: 4 to 64 characters, both entries equal. */
export function pinProblem(pin: string, repeat: string): "short" | "long" | "mismatch" | null {
  const n = [...pin].length;
  if (n < 4) return "short";
  if (n > 64) return "long";
  return pin === repeat ? null : "mismatch";
}

/** The rejection of a command while locked. */
export const isLockedError = (e: unknown) => e === LOCKED_ERROR || String(e) === LOCKED_ERROR;

let waiting: Promise<void> | null = null;

/** Settles when the app is unlocked (at once when it is not locked). */
export function untilUnlocked(): Promise<void> {
  waiting ??= new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      waiting = null;
      ready.then((off) => off()).catch(() => {});
      resolve();
    };
    const ready = listen<boolean>("applock://changed", (e) => {
      if (!e.payload) done();
    });
    // Unlocked before the listener was in place: the status says so.
    ready
      .then(() => invoke<LockStatus>("applock_status"))
      .then((st) => !st.locked && done())
      .catch(() => {});
  });
  return waiting;
}

type Invoke = <R>(cmd: string, args?: Record<string, unknown>) => Promise<R>;

/**
 * `invoke` for the app's commands. A command refused while the app is locked never ran: it waits
 * for the unlock and is sent then. A request on its way when the lock came (a chat being saved, the
 * next step of an answer, a settings write) is done afterwards instead of never settling, which
 * stopped every later save queued behind it for the rest of the session.
 */
export function callUnlocked<R>(cmd: string, args?: Record<string, unknown>, send: Invoke = invoke, unlocked: () => Promise<void> = untilUnlocked): Promise<R> {
  return send<R>(cmd, args).catch((e: unknown) => (isLockedError(e) ? unlocked().then(() => callUnlocked<R>(cmd, args, send, unlocked)) : Promise.reject(e)));
}
