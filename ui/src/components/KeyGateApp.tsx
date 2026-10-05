// The recovery screen at the start: the database is encrypted and its key is missing on this
// computer (a new laptop, a restored disk image, the portable copy elsewhere) or does not fit.
// Opens with the recovery key or, when one is set up, the password; the app then starts again.

import { useEffect, useState, type FormEvent } from "react";
import { FolderOpen, History, KeyRound, LogOut, ShieldAlert } from "lucide-react";
import { ArcaloLogo } from "./Logo";
import { Button, Segmented } from "./ui";
import { setLang, useT } from "../lib/i18n";
import { formatRecoveryInput, recoveryComplete, security, type GateStatus } from "../lib/security";

export function KeyGateApp() {
  const t = useT();
  const [status, setStatus] = useState<GateStatus | null>(null);
  const [method, setMethod] = useState<"recovery" | "password">("recovery");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    security.gateStatus().then(
      (s) => {
        setLang(s.lang);
        setStatus(s);
        // A portable copy on someone else's computer: not stored there unless asked for.
        setRemember(!s.portable);
        if (s.password) setMethod("password");
        document.body.classList.add("ready");
      },
      (e) => {
        setError(String(e));
        document.body.classList.add("ready");
      },
    );
  }, []);

  const ready = method === "recovery" ? recoveryComplete(code) : password.length > 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await security.gateUnlock(method, method === "recovery" ? code : password, remember);
      setOpening(true);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const wrong = status?.reason === "wrong_key";
  return (
    <main className="keygate" aria-labelledby="keygate-title">
      <form className="keygate-card" onSubmit={submit}>
        <div className="keygate-head">
          <ArcaloLogo size={36} />
          <ShieldAlert size={20} className="keygate-badge" aria-hidden />
        </div>
        <h1 id="keygate-title">{wrong ? t("keygate.wrongTitle") : t("keygate.title")}</h1>
        <p className="keygate-text">{wrong ? t("keygate.wrongText") : t("keygate.text")}</p>
        {status?.password && (
          <Segmented
            value={method}
            label={t("keygate.method")}
            options={[
              { value: "password", label: t("keygate.password") },
              { value: "recovery", label: t("keygate.code") },
            ]}
            onChange={(m) => {
              setMethod(m);
              setError(null);
            }}
          />
        )}
        {method === "recovery" ? (
          <label className="keygate-field">
            <span>{t("keygate.code")}</span>
            <textarea
              className="input keygate-code mono"
              rows={2}
              value={code}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder={t("keygate.codePlaceholder")}
              aria-invalid={!!error}
              aria-describedby="keygate-msg"
              onChange={(e) => setCode(formatRecoveryInput(e.target.value))}
            />
            <span className="faint small">{t("keygate.codeHint")}</span>
          </label>
        ) : (
          <label className="keygate-field">
            <span>{t("keygate.password")}</span>
            <input
              type="password"
              className="input"
              value={password}
              autoFocus
              autoComplete="off"
              aria-invalid={!!error}
              aria-describedby="keygate-msg"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        <label className="keygate-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>
            {t("keygate.remember")}
            <span className="faint small"> {status?.portable ? t("keygate.rememberPortable") : t("keygate.rememberHint", { store: status?.store ?? "" })}</span>
          </span>
        </label>
        <p id="keygate-msg" className={`keygate-msg ${error ? "tone-danger" : ""}`} role="status" aria-live="polite">
          {opening ? t("keygate.opening") : (error ?? "")}
        </p>
        <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={!ready}>
          {t("keygate.open")}
        </Button>
        <p className="faint small keygate-lost">{t("keygate.lost")}</p>
        {wrong && !!status?.backups && (
          <div className="keygate-restore">
            <span className="small">{t("keygate.restoreText", { n: status.backups })}</span>
            <Button
              size="sm"
              icon={History}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                security.gateRestore().then(
                  () => setOpening(true),
                  (e) => (setError(String(e)), setBusy(false)),
                );
              }}
            >
              {t("keygate.restore")}
            </Button>
          </div>
        )}
        <div className="keygate-foot">
          <span className="faint small selectable keygate-dir" title={status?.data_dir}>
            {status?.data_dir}
          </span>
          <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void security.gateOpenFolder().catch((e) => setError(String(e)))}>
            {t("keygate.folder")}
          </Button>
          <Button size="sm" variant="ghost" icon={LogOut} onClick={() => void security.gateQuit().catch(() => {})}>
            {t("lock.quit")}
          </Button>
        </div>
      </form>
    </main>
  );
}
