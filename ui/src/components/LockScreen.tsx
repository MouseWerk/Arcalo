// App-Sperre: the lock screen covers the main window (the app behind it is not mounted, so
// nothing of the notes stays in the page), the small windows show a short notice instead of
// their content. Unlock with the PIN, Windows Hello or Touch ID; a forgotten PIN is reset with
// the system's sign-in or the recovery key of the encrypted database.

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Fingerprint, KeyRound, Lock, LogOut } from "lucide-react";
import { AnnaloLogo } from "./Logo";
import { Button, Input } from "./ui";
import { WindowControls } from "./WindowControls";
import { setLang, useT } from "../lib/i18n";
import { formatRecoveryInput, formatWait, recoveryComplete, security, type LockStatus } from "../lib/security";
import { applyPrefs } from "../lib/prefs";
import { api } from "../lib/api";
import { flushAllEditors } from "../editor/saves";

/** Removes the lock by hand where nothing else can (docs/security/encryption.md, „Forgotten PIN“). */
const RESET_COMMAND = `sqlite3 workspace.db "DELETE FROM settings WHERE key LIKE 'meta.applock%'"`;

/** Lock state of this window: `null` until asked. Follows `applock://changed`. */
function useLocked(): [boolean | null, LockStatus | null, () => void] {
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [locked, setLocked] = useState<boolean | null>(null);
  const refresh = useCallback(() => {
    security.lockStatus().then(
      (s) => {
        setStatus(s);
        setLocked(s.locked);
      },
      // No answer (a window without the app state): never block what it shows.
      () => setLocked((l) => l ?? false),
    );
  }, []);
  useEffect(() => {
    refresh();
    const off = listen<boolean>("applock://changed", () => refresh());
    return () => void off.then((f) => f());
  }, [refresh]);
  return [locked, status, refresh];
}

/** The main window: the app, or the lock screen while locked. */
export function LockGate({ children }: { children: ReactNode }) {
  const [locked, status, refresh] = useLocked();
  // Every lock (idle time, sleep, „Jetzt sperren“) waits for the open editors to save: the lock
  // screen unmounts them, and once locked their saves would be refused.
  useEffect(() => {
    const off = listen("applock://locking", () => {
      void flushAllEditors()
        .catch(() => {})
        .then(() => security.lockFlushed())
        .catch(() => {});
    });
    return () => void off.then((f) => f());
  }, []);
  if (locked === null) return null;
  if (locked && status) return <LockScreen status={status} refresh={refresh} />;
  return <>{children}</>;
}

/** Quick capture and quick search: a notice that points to the main window while locked. */
export function PopupLockGate({ children }: { children: ReactNode }) {
  const t = useT();
  const [locked] = useLocked();
  useEffect(() => {
    if (locked) document.body.classList.add("ready");
  }, [locked]);
  if (locked === null) return null;
  if (!locked) return <>{children}</>;
  return (
    <div className="lock-popup" role="alert">
      <Lock size={16} aria-hidden />
      <span>{t("lock.popup")}</span>
      <Button size="sm" variant="primary" onClick={() => void security.showMain().catch(() => {})}>
        {t("lock.unlock")}
      </Button>
    </div>
  );
}

function LockScreen({ status, refresh }: { status: LockStatus; refresh: () => void }) {
  const t = useT();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(status.wait_secs);
  const [forgot, setForgot] = useState(false);
  const [code, setCode] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const osName = status.os_auth === "windows_hello" ? t("lock.hello") : status.os_auth === "touch_id" ? t("lock.touchId") : null;
  const offerOs = !!osName && status.config.os_auth;

  // Theme and language of the settings (the app behind is not loaded).
  useEffect(() => {
    setLang(status.lang);
    api
      .settings()
      .then((v) => applyPrefs(v.settings))
      .catch(() => {});
    document.body.classList.add("ready");
  }, [status.lang]);

  // The countdown after wrong PINs.
  useEffect(() => {
    if (wait <= 0) return;
    const id = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearInterval(id);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (wait === 0) input.current?.focus();
  }, [wait]);

  // Tray „Beenden“ and the window's close button work while locked.
  useEffect(() => {
    const offQuit = listen("app://quit-requested", () => void api.quit().catch(() => {}));
    const win = getCurrentWindow();
    const offClose = win
      .onCloseRequested(async (e) => {
        e.preventDefault();
        const action = await api.closeAction().catch(() => "hide" as const);
        if (action === "quit") await win.destroy().catch(() => {});
        else await api.hideWindow().catch(() => {});
      })
      .catch(() => null);
    return () => {
      void offQuit.then((f) => f());
      void offClose.then((f) => f?.());
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pin || busy || wait > 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await security.unlock(pin);
      if (r.ok) return refresh();
      setPin("");
      setWait(r.wait_secs);
      setError(r.wait_secs > 0 ? t("lock.wrongWait", { n: r.failures }) : t("lock.wrong"));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const viaOs = async () => {
    setBusy(true);
    setError(null);
    try {
      if (await security.unlockOs()) refresh();
      else setError(t("lock.osFailed", { name: osName ?? "" }));
    } catch {
      // The system's sign-in could not be started: the same note as a cancelled one.
      setError(t("lock.osFailed", { name: osName ?? "" }));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (recovery: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await security.resetLock(recovery);
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <div className="lock-drag" data-tauri-drag-region />
      <WindowControls />
      <form className="lock-card" onSubmit={submit}>
        <AnnaloLogo size={44} className="lock-logo" />
        <h1 id="lock-title" className="lock-title">
          {t("lock.title")}
        </h1>
        <p className="lock-sub">{t("lock.sub")}</p>
        <label className="lock-field">
          <span className="sr-only">{t("lock.pin")}</span>
          <input
            ref={input}
            type="password"
            className="input lock-pin"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            value={pin}
            disabled={wait > 0}
            placeholder={t("lock.pin")}
            aria-label={t("lock.pin")}
            aria-invalid={!!error}
            aria-describedby="lock-msg"
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
        <Button type="submit" variant="primary" icon={KeyRound} className="lock-go" loading={busy} disabled={!pin || wait > 0}>
          {t("lock.unlock")}
        </Button>
        {offerOs && (
          <Button icon={Fingerprint} className="lock-os" onClick={() => void viaOs()} disabled={busy}>
            {t("lock.withOs", { name: osName ?? "" })}
          </Button>
        )}
        <p id="lock-msg" className={`lock-msg ${error ? "tone-danger" : ""}`} role="status" aria-live="polite">
          {wait > 0 ? t("lock.waiting", { time: formatWait(wait) }) : (error ?? "")}
        </p>
        {!forgot ? (
          <button type="button" className="lock-link" onClick={() => setForgot(true)}>
            {t("lock.forgot")}
          </button>
        ) : (
          <div className="lock-forgot">
            <p className="small">{status.encrypted ? t("lock.forgotEncrypted") : osName ? t("lock.forgotOs", { name: osName }) : t("lock.forgotNone")}</p>
            {!status.encrypted && !osName && <code className="lock-cmd mono selectable">{RESET_COMMAND}</code>}
            {status.encrypted && (
              <div className="lock-recovery">
                <Input
                  className="lock-code mono"
                  value={code}
                  placeholder={t("keygate.codePlaceholder")}
                  aria-label={t("keygate.code")}
                  spellCheck={false}
                  onChange={(e) => setCode(formatRecoveryInput(e.target.value))}
                />
                <Button disabled={!recoveryComplete(code) || busy} onClick={() => void reset(code)}>
                  {t("lock.resetWithKey")}
                </Button>
              </div>
            )}
            {osName && (
              <Button icon={Fingerprint} disabled={busy} onClick={() => void reset(null)}>
                {t("lock.resetWithOs", { name: osName })}
              </Button>
            )}
          </div>
        )}
        <button type="button" className="lock-link lock-quit" onClick={() => void api.quit().catch(() => {})}>
          <LogOut size={13} aria-hidden /> {t("lock.quit")}
        </button>
      </form>
    </div>
  );
}
