// Setup step „Sicherheit“ (optional, everything off by default): encrypt the database (the
// recovery key is shown and must be confirmed; the encryption runs with one restart when the
// setup is finished) and the app lock with a PIN.

import { useEffect, useState } from "react";
import { Check, Download, Printer } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Button, Switch } from "../components/ui";
import { Select } from "../components/Select";
import { useT } from "../lib/i18n";
import { useApp } from "../store/app";
import { pinProblem, security, type LockMode, type LockStatus } from "../lib/security";
import { StepFrame } from "./steps";
import { useFirstRun } from "./state";

export function SecurityStep() {
  const t = useT();
  const encrypt = useFirstRun((s) => !!s.encrypt);
  const [wants, setWants] = useState(encrypt);
  const [code, setCode] = useState<string | null>(null);
  const [encrypted, setEncrypted] = useState(false);
  const [lock, setLock] = useState<LockStatus | null>(null);
  const [lockOn, setLockOn] = useState(false);
  const [mode, setMode] = useState<LockMode>("start");
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const fail = useApp((s) => s.error);

  useEffect(() => {
    security.cipherStatus().then((c) => setEncrypted(c.state === "encrypted"), () => {});
    security.lockStatus().then((l) => {
      setLock(l);
      setLockOn(l.config.mode !== "off");
      if (l.config.mode !== "off") setMode(l.config.mode);
    }, () => {});
  }, []);
  useEffect(() => {
    if (!wants || code) return;
    security.recoveryKey(true).then(setCode, (e) => (fail(t("sec.key.failed"), e), setWants(false)));
  }, [wants]); // eslint-disable-line react-hooks/exhaustive-deps

  const setEncrypt = (v: boolean) => useFirstRun.setState({ encrypt: v });
  const print = () => {
    document.body.classList.add("print-recovery");
    window.print();
    setTimeout(() => document.body.classList.remove("print-recovery"), 1500);
  };
  const saveFile = async () => {
    if (!code) return;
    const path = await save({ defaultPath: t("sec.key.fileName"), filters: [{ name: t("sec.key.fileFilter"), extensions: ["txt"] }] }).catch(() => null);
    if (path) await security.saveRecovery(path, code).catch((e) => fail(t("sec.key.saveFailed"), e));
  };
  const problem = pinProblem(pin, again);
  const applyLock = (on: boolean) => {
    const config = { ...(lock?.config ?? { idle_minutes: 10, on_sleep: true, os_auth: false }), mode: on ? mode : ("off" as LockMode) };
    return security.configureLock(config, on ? pin : null).then(
      (l) => {
        setLock(l);
        setPin("");
        setAgain("");
      },
      (e) => fail(t("sec.lock.failed"), e),
    );
  };
  const lockActive = !!lock && lock.config.mode !== "off" && lock.has_pin;

  return (
    <StepFrame step="security" title="fr.sec.title" lead="fr.sec.lead">
      <div className="fr-fields fr-sec">
        <div className={`fr-toggle-card ${wants || encrypted ? "on" : ""}`}>
          <span className="fr-choice-text">
            <span className="fr-choice-title">{t("fr.sec.encrypt")}</span>
            <span className="fr-choice-sub">{encrypted ? t("fr.sec.already") : t("fr.sec.encryptText")}</span>
          </span>
          <Switch
            label={t("fr.sec.encrypt")}
            checked={wants || encrypted}
            disabled={encrypted}
            onChange={(v) => {
              setWants(v);
              if (!v) setEncrypt(false);
            }}
          />
        </div>
        {wants && !encrypted && (
          <div className="fr-sec-key">
            <p className="small">{t("fr.sec.keyText")}</p>
            <div className="sec-code mono selectable" aria-label={t("sec.key.label")} data-code={code ?? ""}>
              {code ? code.split("-").map((g, i) => <span key={i}>{g}</span>) : "…"}
            </div>
            <div className="sec-key-actions">
              <Button size="sm" icon={Printer} disabled={!code} onClick={print}>
                {t("sec.key.print")}
              </Button>
              <Button size="sm" icon={Download} disabled={!code} onClick={() => void saveFile()}>
                {t("sec.key.save")}
              </Button>
            </div>
            <label className="sec-confirm">
              <input type="checkbox" checked={encrypt} disabled={!code} onChange={(e) => setEncrypt(e.target.checked)} />
              <span>{t("sec.key.confirm")}</span>
            </label>
            <p className="faint small">{encrypt ? t("fr.sec.onFinish") : t("fr.sec.needConfirm")}</p>
            <div className="recovery-print" aria-hidden>
              <h1>{t("sec.key.printTitle")}</h1>
              <p className="recovery-print-code">{code}</p>
              <p>{t("sec.key.printText")}</p>
            </div>
          </div>
        )}
        <div className={`fr-toggle-card ${lockOn ? "on" : ""}`}>
          <span className="fr-choice-text">
            <span className="fr-choice-title">{t("fr.sec.lock")}</span>
            <span className="fr-choice-sub">{t("fr.sec.lockText")}</span>
          </span>
          <Switch
            label={t("fr.sec.lock")}
            checked={lockOn}
            onChange={(v) => {
              setLockOn(v);
              if (!v && lockActive) void applyLock(false);
            }}
          />
        </div>
        {lockOn && (
          <div className="fr-sec-lock">
            {lockActive ? (
              <p className="fr-sec-done small">
                <Check size={14} aria-hidden /> {t("fr.sec.lockDone")}
              </p>
            ) : (
              <>
                <Select
                  aria-label={t("sec.lock.when")}
                  value={mode}
                  options={[
                    { value: "start", label: t("sec.lock.start") },
                    { value: "idle", label: t("sec.lock.idle") },
                  ]}
                  onChange={(e) => setMode(e.target.value as LockMode)}
                />
                <input type="password" className="input" autoComplete="new-password" aria-label={t("sec.pin.new")} placeholder={t("sec.pin.new")} value={pin} onChange={(e) => setPin(e.target.value)} />
                <input type="password" className="input" autoComplete="new-password" aria-label={t("sec.pin.again")} placeholder={t("sec.pin.again")} value={again} onChange={(e) => setAgain(e.target.value)} />
                <Button variant="primary" disabled={!!problem} onClick={() => void applyLock(true)}>
                  {t("sec.pin.save")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </StepFrame>
  );
}
