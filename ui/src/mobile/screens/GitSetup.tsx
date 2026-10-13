// Einstellungen → Git-Synchronisierung → „Einrichten“ on the phone: the same four steps as the
// desktop's dialog (provider, token, repository, check; lib/useGitSetup.ts), laid out as a screen
// of its own. Android's back button goes one step back, then closes it.

import { useEffect, useRef } from "react";
import { Check, ChevronLeft, CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, Info, Search, Server, TriangleAlert, X } from "lucide-react";
import { t, type TKey } from "../../lib/i18n";
import { fmtDate } from "../../lib/format";
import {
  PROVIDERS,
  scopesFor,
  WIZARD_STEPS,
  addressOf,
  blocker,
  contentKey,
  defaultWeb,
  filterRepos,
  hasApi,
  pastedOf,
  problemKeys,
  stepKey,
  targetName,
  type GitProvider,
  type ParsedAddress,
  type SetupProblem,
} from "../../lib/gitsetup";
import { useGitSetup, type SaveGit } from "../../lib/useGitSetup";
import { useBackLayer } from "../context";
import { Field, Notice, Section, Segmented, Spinner } from "../ui";

const MARK: Record<GitProvider, string> = { github: "GH", gitlab: "GL", gitea: "GT", bitbucket: "BB", other: "" };

export function GitSetupScreen({ tokenStored, remoteUrl, save, onClose, onManual, onSyncNow }: { tokenStored: boolean; remoteUrl?: string; save: SaveGit; onClose: () => void; onManual: () => void; onSyncNow: () => void }) {
  const { s, dispatch, next, openTokenPage } = useGitSetup({ tokenStored, remoteUrl, save });
  const provider = s.provider ?? "other";
  const index = s.step === "done" ? WIZARD_STEPS.length : WIZARD_STEPS.indexOf(s.step);
  const blocked = blocker(s);
  const scroll = useRef<HTMLDivElement>(null);
  const back = () => (index > 0 && s.step !== "done" ? dispatch({ type: "back" }) : onClose());
  useBackLayer(true, back);
  useEffect(() => scroll.current?.scrollTo({ top: 0 }), [s.step]);

  const primary =
    s.step === "check" ? (s.check && !s.check.problem ? t("gitsetup.save") : t("gitsetup.check.again")) : s.step === "repo" && s.mode === "create" ? t("gitsetup.repo.createButton") : s.step === "repo" ? t("gitsetup.check.run") : t("gitsetup.next");
  const list = s.repos ? filterRepos(s.repos, s.query) : null;
  const address = addressOf(s);
  const pasted = pastedOf(s);
  const running = s.step === "check" && (s.busy === "check" || (!s.check && !s.problem));

  return (
    <div className="m-screen m-gs">
      <header className="m-head">
        <button type="button" className="m-icon-btn m-head-back" onClick={back} aria-label={index > 0 && s.step !== "done" ? t("mob.back") : t("common.close")}>
          {index > 0 && s.step !== "done" ? <ChevronLeft size={24} /> : <X size={22} />}
        </button>
        <div className="m-head-titles">
          {s.step !== "done" && <div className="m-eyebrow">{`${t("gitsetup.stepOf", { n: index + 1, total: WIZARD_STEPS.length })} · ${t(`gitsetup.step.${WIZARD_STEPS[index]}` as TKey)}`}</div>}
          <h1 className="m-title">{t("gitsetup.title")}</h1>
        </div>
      </header>
      <div className="m-scroll m-form" ref={scroll}>
        {s.step === "provider" && (
          <>
            <Section title={t("gitsetup.provider.question")} flush>
              <ul className="m-list" role="radiogroup" aria-label={t("gitsetup.provider.question")}>
                {PROVIDERS.map((p) => (
                  <li key={p}>
                    <button type="button" role="radio" aria-checked={s.provider === p} className={`m-row m-gs-provider ${s.provider === p ? "on" : ""}`} onClick={() => dispatch({ type: "provider", provider: p })}>
                      <span className="m-row-icon m-gs-mark" aria-hidden="true">
                        {p === "other" ? <Server size={18} /> : MARK[p]}
                      </span>
                      <span className="m-row-main">
                        <span className="m-row-title">{t(`gitsetup.provider.${p}`)}</span>
                        <span className="m-row-sub">{t(`gitsetup.provider.${p}Desc`)}</span>
                      </span>
                      {s.provider === p && <Check size={20} className="m-gs-check" aria-hidden="true" />}
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
            <Section>
              {s.provider && hasApi(s.provider) && (
                <Field label={t("gitsetup.server")} htmlFor="m-gs-web" hint={s.provider === "gitea" ? t("gitsetup.serverNeeded") : t("gitsetup.serverOwn", { host: defaultWeb(s.provider).replace(/^https:\/\//, "") })}>
                  <input id="m-gs-web" className="m-input" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={s.web} placeholder={defaultWeb(s.provider) || t("gitsetup.serverPlaceholder")} onChange={(e) => dispatch({ type: "web", web: e.target.value })} />
                </Field>
              )}
              <Field label={t("gitsetup.paste")} htmlFor="m-gs-paste" hint={t("gitsetup.pasteHint")}>
                <input id="m-gs-paste" className="m-input" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={s.pasted} placeholder={t("gitsetup.pastePlaceholder")} onChange={(e) => dispatch({ type: "paste", text: e.target.value })} />
              </Field>
              {s.pasted.trim() && <Pasted parsed={pasted} onHttps={(https) => dispatch({ type: "paste", text: https })} />}
            </Section>
          </>
        )}

        {s.step === "token" && (
          <Section title={t("gitsetup.step.token")}>
            <p className="m-desc">{t(`gitsetup.token.${provider}`)}</p>
            {hasApi(provider) && (
              <button type="button" className="m-btn m-btn-block" onClick={() => openTokenPage()}>
                <ExternalLink size={18} />
                {t("gitsetup.token.open")}
              </button>
            )}
            {provider === "github" && (
              <>
                <p className="m-desc m-faint">{t("gitsetup.token.githubFine")}</p>
                <button type="button" className="m-btn m-btn-quiet" onClick={() => openTokenPage(true)}>
                  {t("gitsetup.token.githubFineLink")}
                </button>
              </>
            )}
            <Field label={t("gitsetup.token.label")} htmlFor="m-gs-token" hint={s.tokenStored ? t("gitsetup.token.storedNote") : t("gitsetup.token.safe")}>
              <input id="m-gs-token" className="m-input" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} value={s.token} placeholder={s.tokenStored ? t("set.git.tokenReplace") : t("gitsetup.token.placeholder")} onChange={(e) => dispatch({ type: "token", token: e.target.value })} />
            </Field>
          </Section>
        )}

        {s.step === "repo" && (
          <Section title={t("gitsetup.step.repo")}>
            {s.account && (
              <div className="m-status-line">
                <CircleCheck size={16} className="m-ok-icon" />
                <span>
                  {t("gitsetup.token.signedIn", { login: s.account.login })}
                  {s.account.expires ? ` · ${t("gitsetup.token.expires", { date: fmtDate(`${s.account.expires.slice(0, 10)}T12:00:00`) })}` : ""}
                </span>
              </div>
            )}
            {hasApi(provider) && (
              <Segmented
                label={t("gitsetup.step.repo")}
                value={s.mode}
                onChange={(mode) => dispatch({ type: "mode", mode })}
                options={[
                  { value: "pick", label: t("gitsetup.repo.pick") },
                  { value: "create", label: t("gitsetup.repo.create") },
                  { value: "address", label: t("gitsetup.repo.address") },
                ]}
              />
            )}
            {hasApi(provider) && s.mode === "pick" && (
              <>
                <div className="m-gs-search">
                  <Search size={18} className="m-faint-icon" />
                  <input className="m-input" type="search" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={s.query} placeholder={t("gitsetup.repo.search")} aria-label={t("gitsetup.repo.search")} onChange={(e) => dispatch({ type: "query", query: e.target.value })} />
                </div>
                {s.busy === "repos" || !list ? (
                  <div className="m-loading">
                    <Spinner />
                  </div>
                ) : list.length ? (
                  <>
                    <div className="m-field-hint">{t("gitsetup.repo.count", { n: list.length })}</div>
                    <ul className="m-list m-gs-repos" role="listbox" aria-label={t("gitsetup.step.repo")}>
                      {list.slice(0, 200).map((r) => {
                        const on = s.picked?.full_name === r.full_name;
                        const tags = [r.private ? t("gitsetup.repo.private") : t("gitsetup.repo.public"), r.can_push === false ? t("gitsetup.repo.readOnly") : null, r.empty ? t("gitsetup.repo.empty") : null].filter(Boolean).join(" · ");
                        return (
                          <li key={r.full_name}>
                            <button type="button" role="option" aria-selected={on} className={`m-row m-gs-repo ${on ? "on" : ""}`} onClick={() => dispatch({ type: "pick", repo: r })}>
                              <span className="m-row-main">
                                <span className="m-row-title">{r.full_name}</span>
                                <span className="m-row-sub">{tags}</span>
                              </span>
                              {on && <Check size={20} className="m-gs-check" aria-hidden="true" />}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : (
                  <p className="m-desc">{t("gitsetup.repo.none")}</p>
                )}
              </>
            )}
            {hasApi(provider) && s.mode === "create" && (
              <Field label={t("gitsetup.repo.newName")} htmlFor="m-gs-name" hint={s.account ? t("gitsetup.repo.newHint", { login: s.account.login }) : t("gitsetup.repo.newHintPlain")}>
                <input id="m-gs-name" className="m-input" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={s.newName} onChange={(e) => dispatch({ type: "name", name: e.target.value })} />
              </Field>
            )}
            {(s.mode === "address" || !hasApi(provider)) && (
              <>
                <Field label={t("gitsetup.repo.addressLabel")} htmlFor="m-gs-address" hint={hasApi(provider) ? t("gitsetup.repo.addressHint") : t("gitsetup.repo.addressHintOther")}>
                  <input id="m-gs-address" className="m-input" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={s.address} placeholder={hasApi(provider) ? `${defaultWeb(provider) || t("gitsetup.serverPlaceholder")}/${t("gitsetup.repo.placeholderPath")}` : t("gitsetup.repo.addressPlaceholder")} onChange={(e) => dispatch({ type: "address", address: e.target.value })} />
                </Field>
                {s.address.trim() && address?.ssh && <Pasted parsed={address} onHttps={(https) => dispatch({ type: "address", address: https })} />}
              </>
            )}
            {s.reposProblem && (
              <Notice tone="warning" icon={<TriangleAlert size={18} />}>
                <strong>{t("gitsetup.repo.listFailed")}</strong>
                <span>{t(problemKeys(s.reposProblem.kind).title, { status: s.reposProblem.status ?? "" })}</span>
                <span>{t("gitsetup.repo.listFailedFix")}</span>
              </Notice>
            )}
          </Section>
        )}

        {s.step === "check" && (
          <Section title={t("gitsetup.step.check")}>
            <p className="m-desc">{t("gitsetup.check.intro", { repo: targetName(s) })}</p>
            <ul className="m-gs-checks" aria-busy={running}>
              {(s.check?.steps ?? (hasApi(provider) ? ["server", "token", "repository", "write", "git", "branch"] : ["git", "write", "branch"]).map((id) => ({ id: id as "git", state: "skipped" as const }))).map((st) => (
                <li key={st.id} className={`m-gs-step m-gs-${st.state}`} data-step={st.id} data-state={running ? "running" : st.state}>
                  {running ? <Spinner /> : st.state === "ok" ? <CircleCheck size={18} className="m-ok-icon" /> : st.state === "fail" ? <CircleX size={18} className="m-gs-fail" /> : st.state === "unknown" ? <CircleMinus size={18} className="m-faint-icon" /> : <CircleDashed size={18} className="m-faint-icon" />}
                  <span>{st.id === "branch" && st.state === "ok" && s.check?.branch ? t("gitsetup.check.branchIs", { branch: s.check.branch }) : t(stepKey(st.id, st.state, provider))}</span>
                </li>
              ))}
            </ul>
            {s.problem && !running && (
              <Problem problem={s.problem} provider={provider} https={address?.https ?? null}>
                {["token_missing", "token_invalid", "token_expired", "token_scope"].includes(s.problem.kind) && (
                  <button type="button" className="m-btn" onClick={() => dispatch({ type: "goto", step: "token" })}>
                    {t("gitsetup.check.changeToken")}
                  </button>
                )}
                {["not_found", "no_write", "ssh"].includes(s.problem.kind) && (
                  <button type="button" className="m-btn" onClick={() => dispatch({ type: "goto", step: "repo" })}>
                    {t("gitsetup.check.otherRepo")}
                  </button>
                )}
              </Problem>
            )}
            {s.check && !s.check.problem && contentKey(s.check) && (
              <Notice tone="info" icon={<Info size={18} />}>
                <span>{t(contentKey(s.check) as TKey, { branch: s.check.branch ?? "" })}</span>
              </Notice>
            )}
          </Section>
        )}

        {s.step === "done" && (
          <Section>
            <div className="m-gs-done">
              <CircleCheck size={32} className="m-ok-icon" />
              <h2 className="m-row-title">{t("gitsetup.saved")}</h2>
              <p className="m-desc">{t("gitsetup.done", { repo: targetName(s), branch: s.check?.branch ?? "main" })}</p>
              <p className="m-desc m-faint">{t("gitsetup.doneDescPhone")}</p>
            </div>
          </Section>
        )}

        {s.problem && s.step !== "check" && <Problem problem={s.problem} provider={provider} https={address?.https ?? null} creating={s.step === "repo" && s.mode === "create"} />}

        <div className="m-form-actions m-gs-actions">
          {s.step === "done" ? (
            <>
              <button type="button" className="m-btn" onClick={onClose}>
                {t("common.close")}
              </button>
              <button
                type="button"
                className="m-btn m-btn-primary"
                onClick={() => {
                  onClose();
                  onSyncNow();
                }}
              >
                {t("set.git.syncNow")}
              </button>
            </>
          ) : (
            <button type="button" className="m-btn m-btn-primary m-btn-block" disabled={!!blocked || (!!s.busy && s.busy !== "repos")} onClick={() => void next()}>
              {s.busy && s.busy !== "repos" ? <Spinner /> : null}
              {primary}
            </button>
          )}
        </div>
        {s.step !== "done" && blocked && s.step !== "provider" && <p className="m-field-hint m-gs-blocked">{t(blocked)}</p>}
        {s.step !== "done" && (
          <button type="button" className="m-btn m-btn-quiet m-btn-block" onClick={onManual}>
            {t("gitsetup.manual")}
          </button>
        )}
      </div>
    </div>
  );
}

function Pasted({ parsed, onHttps }: { parsed: ParsedAddress | null; onHttps: (https: string) => void }) {
  if (!parsed) return <div className="m-status-line">{t("gitsetup.pasteInvalid")}</div>;
  if (parsed.ssh && parsed.https) {
    const https = parsed.https;
    return (
      <Notice
        tone="warning"
        icon={<TriangleAlert size={18} />}
        action={
          <button type="button" className="m-btn" onClick={() => onHttps(https)}>
            {t("gitsetup.useHttps")}
          </button>
        }
      >
        <span>{t("gitsetup.sshNote", { https })}</span>
      </Notice>
    );
  }
  return (
    <div className="m-status-line">
      <CircleCheck size={16} className="m-ok-icon" />
      <span>{parsed.owner ? t("gitsetup.pasteFound", { repo: `${parsed.owner}/${parsed.name}`, host: parsed.host }) : t("gitsetup.pasteServer", { host: parsed.host })}</span>
    </div>
  );
}

function Problem({ problem, provider, https, creating, children }: { problem: SetupProblem; provider: GitProvider; https: string | null; creating?: boolean; children?: React.ReactNode }) {
  const keys = problemKeys(problem.kind);
  const vars = { scopes: scopesFor(provider, !!creating), https: https ?? "https://…", status: problem.status ?? "", detail: problem.detail };
  return (
    <Notice tone="error" icon={<TriangleAlert size={18} />} action={children ? <>{children}</> : undefined}>
      <strong className="m-gs-problem" data-kind={problem.kind}>
        {t(keys.title, vars)}
      </strong>
      <span>{t(keys.fix, vars)}</span>
      {problem.detail && (
        <details className="m-gs-detail">
          <summary>{t("gitsetup.details")}</summary>
          <code>{problem.detail}</code>
        </details>
      )}
    </Notice>
  );
}
