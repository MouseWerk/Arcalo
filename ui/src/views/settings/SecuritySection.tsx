// Settings → Sicherheit: the encrypted database (on/off, recovery key, password for a portable
// copy, what stays unencrypted) and the app lock (when, PIN, Windows Hello / Touch ID). Every
// action is a command of its own; nothing here goes through the settings draft except the
// Markdown mirror's switch.

import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Copy, Download, KeyRound, Lock, LockOpen, Printer, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { errorText } from "../../lib/api";
import { Badge, Button, Dialog, Switch } from "../../components/ui";
import { Select } from "../../components/Select";
import { useT } from "../../lib/i18n";
import { useApp } from "../../store/app";
import { flushAllEditors } from "../../editor/saves";
import { pinProblem, security, type CipherStatus, type LockConfig, type LockMode, type LockStatus } from "../../lib/security";
import { Group, NumberInput, Row, SectionHead, StatusNote, type SectionProps } from "./common";

export function SecuritySection({ draft, update, onOpen }: SectionProps & { onOpen: (section: string) => void }) {
  const t = useT();
  const [cipher, setCipher] = useState<CipherStatus | null>(null);
  const [lock, setLock] = useState<LockStatus | null>(null);
  const reload = useCallback(() => {
    security.cipherStatus().then(setCipher, () => setCipher(null));
    security.lockStatus().then(setLock, () => setLock(null));
  }, []);
  useEffect(reload, [reload]);
  return (
    <>
      <SectionHead title={t("sec.title")} intro={t("sec.intro")} />
      {cipher && <EncryptionGroup status={cipher} reload={reload} mirrorOn={draft.markdown_mirror} setMirror={(v) => update({ markdown_mirror: v })} onOpen={onOpen} />}
      {lock && <LockGroup status={lock} setStatus={setLock} />}
    </>
  );
}

// ------------------------------------------------------------- encryption

function EncryptionGroup({
  status,
  reload,
  mirrorOn,
  setMirror,
  onOpen,
}: {
  status: CipherStatus;
  reload: () => void;
  mirrorOn: boolean;
  setMirror: (v: boolean) => void;
  onOpen: (section: string) => void;
}) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const fail = useApp((s) => s.error);
  const [wizard, setWizard] = useState<WizardMode | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const encrypted = status.state === "encrypted";
  const pending = status.pending && status.pending.step !== "swapped";
  return (
    <Group title={t("sec.db.title")} description={t("sec.db.desc")} help="encryption">
      <Row label={t("sec.db.state")} description={encrypted ? t("sec.db.onDesc") : t("sec.db.offDesc")}>
        <div className="sec-state" data-state={status.state}>
          <Badge tone={encrypted ? "success" : "neutral"}>{encrypted ? t("sec.db.on") : t("sec.db.off")}</Badge>
          {encrypted ? (
            <Button icon={LockOpen} className="sec-decrypt" disabled={!!pending} onClick={() => setWizard("decrypt")}>
              {t("sec.db.decrypt")}
            </Button>
          ) : (
            <Button variant="primary" icon={Lock} className="sec-encrypt" disabled={!!pending} onClick={() => setWizard("encrypt")}>
              {t("sec.db.encrypt")}
            </Button>
          )}
        </div>
      </Row>
      {status.store_file && <StatusNote tone="warning" className="sec-note">{t("sec.db.fileStore")}</StatusNote>}
      {status.portable && <StatusNote tone="info" className="sec-note">{t("sec.db.portable")}</StatusNote>}
      {status.old_left && (
        <Row label={t("sec.db.old")} description={t("sec.db.oldDesc")}>
          <Button icon={Trash2} onClick={() => void security.dropOld().then(reload, (e) => fail(t("sec.db.oldFailed"), e))}>
            {t("sec.db.oldDrop")}
          </Button>
        </Row>
      )}
      {encrypted && status.plain_backups > 0 && (
        <Row label={t("sec.db.plainBackups")} description={t("sec.db.plainBackupsDesc", { n: status.plain_backups })}>
          <Button
            icon={Trash2}
            onClick={() =>
              void security.dropPlainBackups().then(
                (n) => (toast({ tone: "success", title: t("sec.db.plainDropped", { n }) }), reload()),
                (e) => fail(t("sec.db.oldFailed"), e),
              )
            }
          >
            {t("sec.db.plainDrop")}
          </Button>
        </Row>
      )}
      <Row label={t("sec.db.mirror")} description={status.git_sync ? t("sec.db.mirrorGitDesc") : t("sec.db.mirrorDesc")} keywords="markdown git">
        <div className="sec-mirror">
          <button type="button" className="link-btn" onClick={() => onOpen("backup")}>
            {t("sec.db.mirrorLink")}
          </button>
          <Switch label={t("sec.db.mirror")} checked={mirrorOn} onChange={setMirror} />
        </div>
      </Row>
      <Row label={t("sec.db.attachments")} description={t("sec.db.attachmentsDesc")}>
        <span className="faint small">{t("sec.db.unencrypted")}</span>
      </Row>
      {status.key_stored && (
        <Row label={t("sec.db.recovery")} description={t("sec.db.recoveryDesc")}>
          <Button icon={KeyRound} onClick={() => setWizard("show")}>
            {t("sec.db.recoveryShow")}
          </Button>
        </Row>
      )}
      {encrypted && status.key_stored && (
        <Row label={t("sec.db.rekey")} description={t("sec.db.rekeyDesc")}>
          <Button icon={RefreshCw} className="sec-rekey" disabled={!!pending} onClick={() => setWizard("rekey")}>
            {t("sec.db.rekeyButton")}
          </Button>
        </Row>
      )}
      {encrypted && (
        <Row label={t("sec.db.password")} description={status.password ? t("sec.db.passwordOn") : t("sec.db.passwordDesc")}>
          {status.password ? (
            <Button onClick={() => void security.setPassword(null).then(reload, (e) => fail(t("sec.db.passwordFailed"), e))}>{t("sec.db.passwordRemove")}</Button>
          ) : (
            <Button onClick={() => setPwOpen(true)}>{t("sec.db.passwordSet")}</Button>
          )}
        </Row>
      )}
      <Row label={t("sec.db.store")} description={t("sec.db.storeDesc")}>
        <span className="small sec-store">{status.store}</span>
      </Row>
      {wizard && <CipherWizard mode={wizard} status={status} onClose={() => setWizard(null)} />}
      {pwOpen && <PasswordDialog onClose={() => (setPwOpen(false), reload())} />}
    </Group>
  );
}

type WizardMode = "encrypt" | "decrypt" | "show" | "rekey";

/**
 * Encrypting and changing the key: what it means, then the (new) recovery key (printed or saved,
 * confirmed), then the restart.
 */
function CipherWizard({ mode, status, onClose: close }: { mode: WizardMode; status: CipherStatus; onClose: () => void }) {
  const t = useT();
  const fail = useApp((s) => s.error);
  const [step, setStep] = useState<"intro" | "key">(mode === "show" ? "key" : "intro");
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const rekey = mode === "rekey";
  // Closed without changing the key: the prepared new key is dropped.
  const onClose = () => {
    if (rekey && !busy) void security.rekeyCancel().catch(() => {});
    close();
  };

  useEffect(() => {
    if (step !== "key" || code) return;
    const load = rekey ? security.rekeyPrepare() : security.recoveryKey(mode === "encrypt");
    load.then(setCode, (e) => (fail(t("sec.key.failed"), e), onClose()));
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const print = () => {
    document.body.classList.add("print-recovery");
    const done = () => {
      document.body.classList.remove("print-recovery");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1500);
  };
  const saveFile = async () => {
    if (!code) return;
    const path = await save({ defaultPath: t("sec.key.fileName"), filters: [{ name: t("sec.key.fileFilter"), extensions: ["txt"] }] }).catch(() => null);
    if (!path) return;
    await security.saveRecovery(path, code).then(
      () => useApp.getState().toast({ tone: "success", title: t("sec.key.savedFile") }),
      (e) => fail(t("sec.key.saveFailed"), e),
    );
  };
  const go = async (encrypt: boolean) => {
    setBusy(true);
    // The restart closes the workspace: the open notes are stored first.
    await flushAllEditors().catch(() => {});
    await security.switchCipher(encrypt).catch((e) => (fail(t("sec.key.switchFailed"), e), setBusy(false)));
  };
  const goRekey = async () => {
    setBusy(true);
    setPwError(null);
    await flushAllEditors().catch(() => {});
    await security.rekey(status.password ? password : null).catch((e) => {
      setBusy(false);
      // A wrong password is answered next to the field; anything else as a toast.
      if (status.password) setPwError(errorText(e));
      else fail(t("sec.key.switchFailed"), e);
    });
  };

  if (mode === "decrypt") {
    return (
      <Dialog
        open
        onClose={onClose}
        title={t("sec.dec.title")}
        width={520}
        footer={
          <>
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="danger" className="sec-go" loading={busy} onClick={() => void go(false)}>
              {t("sec.dec.go")}
            </Button>
          </>
        }
      >
        <p>{t("sec.dec.text")}</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === "show" ? t("sec.key.title") : rekey ? t("sec.rk.title") : t("sec.enc.title")}
      width={600}
      footer={
        step === "intro" ? (
          <>
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" className="sec-next" onClick={() => setStep("key")}>
              {t("sec.enc.next")}
            </Button>
          </>
        ) : mode === "show" ? (
          <Button onClick={onClose}>{t("common.close")}</Button>
        ) : rekey ? (
          <>
            <Button onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" icon={RefreshCw} className="sec-go" disabled={!saved || !code || (status.password && !password)} loading={busy} onClick={() => void goRekey()}>
              {t("sec.rk.go")}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" icon={ShieldCheck} className="sec-go" disabled={!saved || !code} loading={busy} onClick={() => void go(true)}>
              {t("sec.enc.go")}
            </Button>
          </>
        )
      }
    >
      {step === "intro" && rekey ? (
        <div className="sec-intro">
          <p>{t("sec.rk.text")}</p>
          <ul className="sec-list">
            <li>{t("sec.rk.oldInvalid")}</li>
            <li>{t("sec.rk.backups")}</li>
            <li>{t("sec.rk.safe")}</li>
            <li>{t("sec.rk.restart")}</li>
          </ul>
        </div>
      ) : step === "intro" ? (
        <div className="sec-intro">
          <p>{t("sec.enc.text")}</p>
          <ul className="sec-list">
            <li>{t("sec.enc.what")}</li>
            <li>{t("sec.enc.notMirror")}</li>
            <li>{t("sec.enc.notAttachments")}</li>
            <li>{t("sec.enc.backups")}</li>
            <li>{t("sec.enc.restart")}</li>
          </ul>
          {status.store_file && <StatusNote tone="warning">{t("sec.db.fileStore")}</StatusNote>}
          {status.portable && <StatusNote tone="info">{t("sec.db.portable")}</StatusNote>}
        </div>
      ) : (
        <div className="sec-key">
          <p>{mode === "show" ? t("sec.key.showText") : rekey ? t("sec.rk.keyText") : t("sec.key.text")}</p>
          <div className="sec-code mono selectable" aria-label={t("sec.key.label")} data-code={code ?? ""}>
            {code ? code.split("-").map((g, i) => <span key={i}>{g}</span>) : "…"}
          </div>
          <div className="sec-key-actions">
            <Button icon={Printer} disabled={!code} onClick={print}>
              {t("sec.key.print")}
            </Button>
            <Button icon={Download} disabled={!code} onClick={() => void saveFile()}>
              {t("sec.key.save")}
            </Button>
            <Button icon={Copy} disabled={!code} onClick={() => void navigator.clipboard.writeText(code ?? "").catch(() => {})}>
              {t("sec.key.copy")}
            </Button>
          </div>
          {(mode === "encrypt" || rekey) && (
            <label className="sec-confirm">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              <span>{rekey ? t("sec.rk.confirm") : t("sec.key.confirm")}</span>
            </label>
          )}
          {rekey && status.password && (
            <div className="sec-rekey-pw">
              <input
                type="password"
                className="input"
                autoComplete="current-password"
                aria-label={t("sec.rk.password")}
                placeholder={t("sec.rk.password")}
                aria-invalid={!!pwError}
                value={password}
                onChange={(e) => (setPassword(e.target.value), setPwError(null))}
              />
              <p className={`small ${pwError ? "mirror-error" : "faint"}`} role={pwError ? "alert" : undefined}>
                {pwError ?? t("sec.rk.passwordHint")}
              </p>
            </div>
          )}
          <div className="recovery-print" aria-hidden>
            <h1>{t("sec.key.printTitle")}</h1>
            <p className="recovery-print-code">{code}</p>
            <p>{t("sec.key.printText")}</p>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = pw.length < 10 ? t("sec.pw.short") : pw !== again ? t("sec.pin.mismatch") : null;
  const submit = async () => {
    setBusy(true);
    setError(null);
    await security.setPassword(pw).then(onClose, (e) => (setError(String(e)), setBusy(false)));
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("sec.pw.title")}
      description={t("sec.pw.desc")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!!problem} loading={busy} onClick={() => void submit()}>
            {t("sec.pw.save")}
          </Button>
        </>
      }
    >
      <form className="sec-pin-form" onSubmit={(e) => (e.preventDefault(), !problem && !busy && void submit())}>
        <input type="password" className="input" autoComplete="new-password" aria-label={t("sec.pw.new")} placeholder={t("sec.pw.new")} value={pw} onChange={(e) => setPw(e.target.value)} />
        <input type="password" className="input" autoComplete="new-password" aria-label={t("sec.pin.again")} placeholder={t("sec.pin.again")} value={again} onChange={(e) => setAgain(e.target.value)} />
        <p className={`small ${error ? "mirror-error" : "faint"}`} role="status">
          {error ?? (pw ? (problem ?? "") : "")}
        </p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// --------------------------------------------------------------- app lock

function LockGroup({ status, setStatus }: { status: LockStatus; setStatus: (s: LockStatus) => void }) {
  const t = useT();
  const fail = useApp((s) => s.error);
  // A change that needs a PIN first (switching the lock on).
  const [pinFor, setPinFor] = useState<LockConfig | null>(null);
  const c = status.config;
  /** Stores `next` (with a new PIN); false when it was refused (the error is shown). */
  const apply = (next: LockConfig, pin: string | null = null): Promise<boolean> =>
    security.configureLock(next, pin).then(
      (s) => (setStatus(s), true),
      (e) => (fail(t("sec.lock.failed"), e), false),
    );
  const change = (patch: Partial<LockConfig>) => {
    const next = { ...c, ...patch };
    if (next.mode !== "off" && !status.has_pin) setPinFor(next);
    else void apply(next);
  };
  const osName = status.os_auth === "windows_hello" ? t("lock.hello") : status.os_auth === "touch_id" ? t("lock.touchId") : null;
  const modes: { value: LockMode; label: string }[] = [
    { value: "off", label: t("sec.lock.off") },
    { value: "start", label: t("sec.lock.start") },
    { value: "idle", label: t("sec.lock.idle") },
  ];
  return (
    <Group title={t("sec.lock.title")} description={t("sec.lock.desc")}>
      <Row label={t("sec.lock.when")} description={t("sec.lock.whenDesc")}>
        <Select className="sec-lock-mode" aria-label={t("sec.lock.when")} value={c.mode} options={modes} onChange={(e) => change({ mode: e.target.value as LockMode })} />
      </Row>
      {c.mode === "idle" && (
        <Row label={t("sec.lock.minutes")} description={t("sec.lock.minutesDesc")}>
          <NumberInput value={c.idle_minutes} min={1} max={240} onCommit={(v) => change({ idle_minutes: v })} aria-label={t("sec.lock.minutes")} />
        </Row>
      )}
      {c.mode !== "off" && (
        <>
          <Row label={t("sec.lock.sleep")} description={t("sec.lock.sleepDesc")}>
            <Switch label={t("sec.lock.sleep")} checked={c.on_sleep} onChange={(v) => change({ on_sleep: v })} />
          </Row>
          <Row label={t("sec.lock.pin")} description={t("sec.lock.pinDesc")}>
            <Button icon={KeyRound} onClick={() => setPinFor(c)}>
              {t("sec.lock.pinChange")}
            </Button>
          </Row>
          {osName && (
            <Row label={t("sec.lock.os", { name: osName })} description={t("sec.lock.osDesc")}>
              <Switch label={t("sec.lock.os", { name: osName })} checked={c.os_auth} onChange={(v) => change({ os_auth: v })} />
            </Row>
          )}
          <Row label={t("sec.lock.now")} description={t("sec.lock.forgotDesc")}>
            <Button
              icon={Lock}
              className="sec-lock-now"
              onClick={() => void flushAllEditors().catch(() => {}).then(() => security.lockNow()).catch((e) => fail(t("sec.lock.failed"), e))}
            >
              {t("sec.lock.nowButton")}
            </Button>
          </Row>
        </>
      )}
      {pinFor && (
        <PinDialog
          noReset={!status.encrypted && !osName}
          onClose={() => setPinFor(null)}
          onSave={(pin) =>
            void apply(pinFor, pin).then((ok) => {
              // Refused: the dialog stays open with what was typed.
              if (!ok) return;
              setPinFor(null);
              useApp.getState().toast({ tone: "success", title: t("sec.pin.saved") });
            })
          }
        />
      )}
    </Group>
  );
}

/** `noReset`: a forgotten PIN cannot be reset in the app here (said before it is set). */
function PinDialog({ noReset, onClose, onSave }: { noReset: boolean; onClose: () => void; onSave: (pin: string) => void }) {
  const t = useT();
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const problem = pinProblem(pin, again);
  const text = problem === "short" ? t("sec.pin.short") : problem === "long" ? t("sec.pin.long") : problem === "mismatch" ? t("sec.pin.mismatch") : "";
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("sec.pin.title")}
      description={t("sec.pin.desc")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" className="sec-pin-save" disabled={!!problem} onClick={() => onSave(pin)}>
            {t("sec.pin.save")}
          </Button>
        </>
      }
    >
      <form className="sec-pin-form" onSubmit={(e) => (e.preventDefault(), !problem && onSave(pin))}>
        <input type="password" className="input sec-pin-1" autoComplete="new-password" aria-label={t("sec.pin.new")} placeholder={t("sec.pin.new")} value={pin} onChange={(e) => setPin(e.target.value)} />
        <input type="password" className="input sec-pin-2" autoComplete="new-password" aria-label={t("sec.pin.again")} placeholder={t("sec.pin.again")} value={again} onChange={(e) => setAgain(e.target.value)} />
        <p className="small faint" role="status">
          {pin ? text : ""}
        </p>
        {noReset && <StatusNote tone="warning" className="sec-pin-noreset">{t("sec.pin.noReset")}</StatusNote>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
