// Einstellungen: the Git sync (the guided setup, or repository, branch, token in the Android Keystore; sync now,
// conflicts), theme and contrast, language, the app's updates and what the app is.

import { useEffect, useState } from "react";
import { CircleCheck, Compass, KeyRound, TriangleAlert } from "lucide-react";
import { api } from "../../lib/api";
import { buildResult, chooseAll } from "../../lib/conflict";
import { relative } from "../../lib/format";
import { t } from "../../lib/i18n";
import type { GitConflictInfo, GitConflictView, GitSyncStatus, Settings } from "../../lib/types";
import { errorText, useMobile } from "../context";
import { syncState } from "../model";
import { Field, Header, Notice, Section, Segmented, Spinner, Switch } from "../ui";
import { UpdateSection } from "../update";
import { interfaceSettingChanged } from "../../lib/uiswitch";
import { onIos } from "../../lib/capabilities";
import type { SaveGit } from "../../lib/useGitSetup";
import { GitSetupScreen } from "./GitSetup";

/** The high contrast themes (lib/themes.ts) for „Hoher Kontrast“. */
const CONTRAST = { light: "contrast-light", dark: "contrast-dark" } as const;

export function SettingsScreen() {
  const m = useMobile();
  const s = m.settings;
  const gs = s.git_sync;
  const [remote, setRemote] = useState(gs.remote_url);
  const [branch, setBranch] = useState(gs.branch);
  const [author, setAuthor] = useState(gs.author_name);
  const [email, setEmail] = useState(gs.author_email);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<GitSyncStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<GitConflictInfo[]>([]);
  const [confirmDeletions, setConfirmDeletions] = useState(false);
  const [setup, setSetup] = useState(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    let live = true;
    api.gitSyncStatus().then((x) => live && setStatus(x)).catch(() => {});
    api.gitConflicts().then((c) => live && setConflicts(c)).catch(() => {});
    return () => {
      live = false;
    };
  }, [m.version]);

  const save = (next: Settings) => m.saveSettings(next).catch((e) => m.toast("error", t("common.saveFailed"), errorText(e)));
  const saveGit = (patch: Partial<Settings["git_sync"]>) => save({ ...s, git_sync: { ...gs, ...patch, include_database: false } });
  // The phone's git has no SSH: an SSH address is refused here, with the reason.
  const saveRemote = () => {
    if (remote.trim() && !/^https?:\/\//i.test(remote.trim())) {
      m.toast("error", t("mob.set.httpsOnly"));
      return;
    }
    void saveGit({ remote_url: remote.trim(), branch: branch.trim() || "main", author_name: author.trim(), author_email: email.trim() }).then(() => m.toast("success", t("mob.set.saved")));
  };
  const dirty = remote.trim() !== gs.remote_url || branch.trim() !== gs.branch || author.trim() !== gs.author_name || email.trim() !== gs.author_email;

  const saveToken = async () => {
    try {
      setStatus(await api.setGitToken(token.trim() || null));
      setToken("");
      m.toast("success", token.trim() ? t("set.git.tokenSaved") : t("set.git.tokenRemoved"));
    } catch (e) {
      m.toast("error", t("set.git.tokenFailed"), errorText(e));
    }
  };
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.gitSyncTest(remote.trim() || null, token.trim() || null);
      setTest([r.ok ? t("set.git.connected", { n: r.branches.length, ms: r.latency_ms }) : (r.error ?? ""), r.note].filter(Boolean).join(" "));
    } catch (e) {
      setTest(errorText(e));
    } finally {
      setTesting(false);
    }
  };
  const state = syncState(gs.enabled || !!gs.remote_url, gs.remote_url, status);
  const contrast = s.appearance?.theme_light === CONTRAST.light && s.appearance?.theme_dark === CONTRAST.dark;
  const showForm = !!gs.remote_url || manual;

  // The guided setup takes the screen; its save is the form's (the token was stored by the setup).
  const saveFromSetup: SaveGit = async (patch) => {
    const before = gs;
    await m.saveSettings({ ...s, git_sync: { ...gs, ...patch, include_database: false } });
    setRemote(patch.remote_url);
    setBranch(patch.branch);
    setStatus(await api.gitSyncStatus().catch(() => null));
    // The token could not be stored after them: the settings from before.
    return async () => {
      await m.saveSettings({ ...s, git_sync: before });
      setRemote(before.remote_url);
      setBranch(before.branch);
    };
  };
  if (setup) {
    return (
      <GitSetupScreen
        tokenStored={!!status?.token_set}
        remoteUrl={gs.remote_url || undefined}
        save={saveFromSetup}
        onClose={() => setSetup(false)}
        onManual={() => {
          setSetup(false);
          setManual(true);
        }}
        onSyncNow={() => void m.sync()}
      />
    );
  }

  return (
    <div className="m-screen">
      <Header title={t("mob.set.title")} back="back" />
      <div className="m-scroll m-form">
        <Section title={t("mob.set.sync")}>
          <p className="m-desc">{t("mob.set.syncDesc")}</p>
          {!gs.remote_url && <p className="m-desc m-faint">{t("gitsetup.entryDesc")}</p>}
          <div className="m-form-actions m-gs-entry">
            <button type="button" className={gs.remote_url ? "m-btn" : "m-btn m-btn-primary"} onClick={() => setSetup(true)}>
              <Compass size={18} />
              {gs.remote_url ? t("gitsetup.reopen") : t("gitsetup.open")}
            </button>
            {!gs.remote_url && !manual && (
              <button type="button" className="m-btn m-btn-quiet" onClick={() => setManual(true)}>
                {t("gitsetup.manual")}
              </button>
            )}
          </div>
          {showForm && (
            <>
              <div className="m-divider" />
              <Field label={t("set.git.remote")} htmlFor="m-git-url" hint={t("mob.set.remoteDesc")}>
                <input id="m-git-url" className="m-input" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={remote} placeholder={t("set.git.remotePlaceholder")} onChange={(e) => setRemote(e.target.value)} />
              </Field>
              <div className="m-field-pair">
                <Field label={t("set.git.branch")} htmlFor="m-git-branch">
                  <input id="m-git-branch" className="m-input" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={branch} onChange={(e) => setBranch(e.target.value)} />
                </Field>
                <Field label={t("set.git.authorName")} htmlFor="m-git-author">
                  <input id="m-git-author" className="m-input" value={author} onChange={(e) => setAuthor(e.target.value)} />
                </Field>
              </div>
              <Field label={t("set.git.authorEmail")} htmlFor="m-git-email">
                <input id="m-git-email" className="m-input" type="email" inputMode="email" autoCapitalize="off" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              {dirty && (
                <div className="m-form-actions">
                  <button type="button" className="m-btn m-btn-primary m-btn-block" onClick={saveRemote}>
                    {t("mob.set.saveRemote")}
                  </button>
                </div>
              )}
              <Field label={t("set.git.token")} htmlFor="m-git-token" hint={t("set.git.tokenDesc")}>
                <div className="m-input-row">
                  <input id="m-git-token" className="m-input" type="password" autoComplete="off" value={token} placeholder={status?.token_set ? t("set.git.tokenReplace") : ""} onChange={(e) => setToken(e.target.value)} />
                  <button type="button" className="m-btn" disabled={!token.trim() && !status?.token_set} onClick={() => void saveToken()}>
                    {token.trim() || !status?.token_set ? t("mob.set.tokenSave") : t("common.remove")}
                  </button>
                </div>
              </Field>
              {status?.token_set && (
                <div className="m-status-line">
                  <KeyRound size={16} />
                  {t(onIos() ? "mob.set.tokenStoredIos" : "mob.set.tokenStored")}
                </div>
              )}
              <div className="m-divider" />
              <Switch checked={gs.enabled} onChange={(v) => void saveGit({ enabled: v })} label={t("mob.set.syncOn")} desc={t("mob.set.syncOnDesc")} />
              <div className="m-divider" />
              <div className="m-sync-status">
                <span className="m-row-main">
                  <span className="m-row-title">{t("set.git.last")}</span>
                  <span className="m-row-sub">
                    {status?.last_at ? relative(status.last_at) : t("set.git.never")}
                    {status && status.pending_changes > 0 ? ` · ${t("set.git.pending", { n: status.pending_changes })}` : ""}
                  </span>
                </span>
                {state === "ok" && <CircleCheck size={18} className="m-ok-icon" />}
              </div>
              {status?.last_error && (
                <Notice tone="error" icon={<TriangleAlert size={18} />}>
                  {status.last_error}
                </Notice>
              )}
              {status?.blocked_deletions ? (
                <Notice
                  tone="warning"
                  icon={<TriangleAlert size={18} />}
                  action={
                    <button
                      type="button"
                      className={confirmDeletions ? "m-btn m-btn-danger" : "m-btn"}
                      onClick={() => {
                        if (!confirmDeletions) return setConfirmDeletions(true);
                        setConfirmDeletions(false);
                        void m.sync({ allowDeletions: true });
                      }}
                    >
                      {confirmDeletions ? t("set.git.deleteConfirm") : t("set.git.deletionsPush")}
                    </button>
                  }
                >
                  <strong>{t("set.git.deletionsHeld")}</strong>
                  <span>{t("set.git.deletionsHeldDesc", { n: status.blocked_deletions })}</span>
                </Notice>
              ) : null}
              {test && <div className="m-status-line">{test}</div>}
              <div className="m-form-actions">
                <button type="button" className="m-btn" disabled={testing || !remote.trim()} onClick={() => void runTest()}>
                  {testing ? <Spinner /> : null}
                  {t("set.git.test")}
                </button>
                <button type="button" className="m-btn m-btn-primary" disabled={m.syncing || !gs.remote_url.trim()} onClick={() => void m.sync()}>
                  {m.syncing ? <Spinner /> : null}
                  {m.syncing ? t("mob.set.syncing") : t("set.git.syncNow")}
                </button>
              </div>
            </>
          )}
        </Section>

        {conflicts.length > 0 && (
          <Section title={t("mob.set.conflicts")} flush>
            <ul className="m-list">
              {conflicts.map((c) => (
                <ConflictRow key={c.page_id} info={c} />
              ))}
            </ul>
          </Section>
        )}

        <Section title={t("mob.set.appearance")}>
          <Segmented
            label={t("mob.set.appearance")}
            value={s.theme}
            onChange={(v) => void save({ ...s, theme: v })}
            options={[
              { value: "system", label: t("set.appearance.system") },
              { value: "light", label: t("set.appearance.light") },
              { value: "dark", label: t("set.appearance.dark") },
            ]}
          />
          <Switch
            checked={contrast}
            onChange={(on) =>
              void save({
                ...s,
                appearance: { ...s.appearance, theme_light: on ? CONTRAST.light : "arcalo-light", theme_dark: on ? CONTRAST.dark : "arcalo-dark" },
              })
            }
            label={t("mob.set.contrast")}
            desc={t("mob.set.contrastDesc")}
          />
        </Section>

        {/* The phone app or the full app (lib/uiswitch.ts follows the change at once). */}
        <Section title={t(onIos() ? "set.appearance.uiIos" : "set.appearance.ui")}>
          <Segmented
            label={t(onIos() ? "set.appearance.uiIos" : "set.appearance.ui")}
            value={s.appearance?.android_interface ?? "auto"}
            onChange={(v) => void save({ ...s, appearance: { ...s.appearance, android_interface: v } }).then(interfaceSettingChanged)}
            options={[
              { value: "auto", label: t("set.appearance.uiAuto") },
              { value: "phone", label: t("set.appearance.uiPhone") },
              { value: "full", label: t("set.appearance.uiFull") },
            ]}
          />
          <p className="m-desc">{t(onIos() ? "set.appearance.uiDescIos" : "set.appearance.uiDesc")}</p>
        </Section>

        <Section title={t("mob.set.language")}>
          <Segmented
            label={t("mob.set.language")}
            value={s.locale.language === "de" || s.locale.language === "en" ? s.locale.language : "system"}
            onChange={(v) => void save({ ...s, locale: { ...s.locale, language: v } })}
            options={[
              { value: "system", label: t("set.locale.followSystem") },
              { value: "de", label: t("mob.set.langDe") },
              { value: "en", label: t("mob.set.langEn") },
            ]}
          />
        </Section>

        {!onIos() && (
          <Section title={t("mob.upd.title")}>
            <UpdateSection />
          </Section>
        )}

        <Section title={t("mob.set.about")}>
          <div className="m-about">
            <div className="m-about-mark" aria-hidden="true">
              <svg viewBox="0 0 1000 1000">
                <path
                  fillRule="evenodd"
                  d="M458.0,103.4 L491.0,160.1 L96.3,842.8 L256.8,842.8 L305.0,769.1 L235.1,769.1 L268.2,710.6 L687.4,710.6 L760.2,839.9 L902.7,839.9 L574.1,262.0 L535.4,327.2 L628.0,486.8 L502.4,689.8 L377.7,486.8 L574.1,145.9 L1000.0,896.6 L722.4,896.6 L647.8,769.1 L365.4,769.1 L289.9,896.6 L0.0,896.6 Z M502.4,382.0 L562.8,486.8 L502.4,582.2 L441.9,486.8 Z"
                />
              </svg>
            </div>
            <div>
              <div className="m-row-title">Arcalo</div>
              <div className="m-row-sub">{t("mob.set.version", { version: m.view.version })}</div>
            </div>
          </div>
          <p className="m-desc">{t(onIos() ? "mob.set.aboutTextIos" : "mob.set.aboutText")}</p>
          <p className="m-desc m-faint">{t("mob.set.secrets", { store: m.view.api_key_storage })}</p>
        </Section>
      </div>
    </div>
  );
}

/** A note changed here and on the server: merged when that works by itself, else mine or
 *  theirs everywhere (spot by spot on the desktop). */
function ConflictRow({ info }: { info: GitConflictInfo }) {
  const m = useMobile();
  const [view, setView] = useState<GitConflictView | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.gitConflict(info.page_id).then(setView).catch(() => {});
  }, [info.page_id]);
  const resolve = async (content: string | null, both = false) => {
    setBusy(true);
    try {
      const out = both ? await api.keepBothGitConflict(info.page_id) : content !== null ? await api.resolveGitConflict(info.page_id, content) : null;
      m.toast("success", t("cf.solved"), t("cf.merged", { title: info.title }));
      // The sync after the decision failed: the decision stays, the next sync uploads it.
      if (out?.sync_error) m.toast("error", t("cf.mergedNotSynced"), out.sync_error);
      m.refresh();
    } catch (e) {
      m.toast("error", t("cf.applyFailed"), errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const chunks = view?.merge.chunks ?? [];
  const auto = view && view.merge.conflicts === 0 ? buildResult(chunks, new Map()) : null;
  return (
    <li className="m-conflict">
      <button type="button" className="m-row" onClick={() => m.open({ kind: "page", id: info.page_id })}>
        <span className="m-row-main">
          <span className="m-row-title">{info.title}</span>
          <span className="m-row-sub">{view ? (view.merge.conflicts ? t("mob.set.conflictSpots", { n: view.merge.conflicts }) : t("cf.allAuto")) : info.path}</span>
        </span>
      </button>
      {view && (
        <div className="m-conflict-actions">
          {auto !== null ? (
            <button type="button" className="m-btn m-btn-primary" disabled={busy} onClick={() => void resolve(auto)}>
              {t("mob.set.conflictMerge")}
            </button>
          ) : (
            <>
              <button type="button" className="m-btn" disabled={busy} onClick={() => void resolve(buildResult(chunks, chooseAll(chunks, "mine")))}>
                {t("cf.allMine")}
              </button>
              <button type="button" className="m-btn" disabled={busy} onClick={() => void resolve(buildResult(chunks, chooseAll(chunks, "theirs")))}>
                {t("cf.allTheirs")}
              </button>
            </>
          )}
          <button type="button" className="m-btn m-btn-quiet" disabled={busy} onClick={() => void resolve(null, true)}>
            {t("cf.keepBoth")}
          </button>
        </div>
      )}
      {view && view.merge.conflicts > 0 && <p className="m-faint m-conflict-hint">{t("mob.set.conflictDesktop")}</p>}
    </li>
  );
}
