// Settings → Sicherung → „Git-Synchronisierung einrichten…“: the guided setup in a dialog
// (provider, token, repository, check). The behavior is lib/useGitSetup.ts, shared with the
// phone's screen; „Manuell einrichten“ leads to the form below the group.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, CheckCircle2, CircleDashed, CircleMinus, Eye, EyeOff, ExternalLink, Info, KeyRound, Loader2, Search, Server, TriangleAlert, XCircle } from "lucide-react";
import { Badge, Button, Dialog, Field, IconButton, Input, Segmented, Skeleton } from "../../components/ui";
import { useT, type TKey } from "../../lib/i18n";
import { isKey } from "../../lib/ime";
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
  canCreate,
  hasApi,
  tokenNote,
  pastedOf,
  problemKeys,
  stepKey,
  targetName,
  type GitProvider,
  type ParsedAddress,
  type SetupProblem,
  type WizardState,
} from "../../lib/gitsetup";
import { useGitSetup, type SaveGit } from "../../lib/useGitSetup";

/** Short marks of the providers in their cards (no brand logos). */
const MARK: Record<GitProvider, string> = { github: "GH", gitlab: "GL", gitea: "GT", bitbucket: "BB", other: "" };

export function GitSetupWizard({
  tokenStored,
  remoteUrl,
  save,
  onClose,
  onManual,
  onSyncNow,
}: {
  tokenStored: boolean;
  remoteUrl?: string;
  save: SaveGit;
  onClose: () => void;
  onManual: () => void;
  onSyncNow: () => void;
}) {
  const t = useT();
  const { s, dispatch, next, openTokenPage } = useGitSetup({ tokenStored, remoteUrl, save });
  const body = useRef<HTMLDivElement>(null);
  const provider = s.provider ?? "other";
  const index = s.step === "done" ? WIZARD_STEPS.length : WIZARD_STEPS.indexOf(s.step);
  const blocked = blocker(s);

  // Each step starts at its first field (or its main button).
  useEffect(() => {
    const id = setTimeout(() => body.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus(), 30);
    return () => clearTimeout(id);
  }, [s.step, s.mode]);

  const onEnter = (e: React.KeyboardEvent) => {
    if (isKey(e, "Enter") && !blocked) {
      e.preventDefault();
      void next();
    }
  };

  const primary =
    s.step === "check"
      ? s.check && !s.check.problem
        ? t("gitsetup.save")
        : t("gitsetup.check.again")
      : s.step === "repo" && s.mode === "create"
        ? t("gitsetup.repo.createButton")
        : s.step === "repo"
          ? t("gitsetup.check.run")
          : t("gitsetup.next");

  const footer =
    s.step === "done" ? (
      <>
        <Button onClick={onClose}>{t("common.close")}</Button>
        <Button
          variant="primary"
          data-autofocus
          onClick={() => {
            onClose();
            onSyncNow();
          }}
        >
          {t("set.git.syncNow")}
        </Button>
      </>
    ) : (
      <>
        <Button variant="ghost" className="gs-manual" onClick={onManual}>
          {t("gitsetup.manual")}
        </Button>
        {index > 0 && (
          <Button onClick={() => dispatch({ type: "back" })} disabled={!!s.busy && s.busy !== "check"}>
            {t("gitsetup.back")}
          </Button>
        )}
        <Button variant="primary" onClick={() => void next()} loading={!!s.busy && s.busy !== "repos"} disabled={!!blocked || s.busy === "check"} title={blocked ? t(blocked) : undefined} className="gs-primary">
          {primary}
        </Button>
      </>
    );

  return (
    <Dialog open onClose={onClose} title={t("gitsetup.title")} width={640} footer={footer} description={s.step === "done" ? undefined : <Steps current={index} />}>
      <div className="gs-body" ref={body}>
        {s.step === "provider" && <ProviderStep s={s} dispatch={dispatch} onEnter={onEnter} />}
        {s.step === "token" && <TokenStep s={s} dispatch={dispatch} onEnter={onEnter} openTokenPage={openTokenPage} />}
        {s.step === "repo" && <RepoStep s={s} dispatch={dispatch} onEnter={onEnter} />}
        {s.step === "check" && <CheckStep s={s} provider={provider} onGoto={(step) => dispatch({ type: "goto", step })} />}
        {s.step === "done" && (
          <div className="gs-done">
            <CheckCircle2 size={28} className="gs-done-icon" aria-hidden />
            <div>
              <h3 className="gs-done-title">{t("gitsetup.saved")}</h3>
              <p className="gs-text">{t("gitsetup.done", { repo: targetName(s), branch: s.check?.branch ?? "main" })}</p>
              <p className="gs-text faint">{t("gitsetup.doneDesc")}</p>
            </div>
          </div>
        )}
        {s.problem && s.step !== "check" && <ProblemNote problem={s.problem} provider={provider} https={addressOf(s)?.https ?? null} creating={s.step === "repo" && s.mode === "create"} />}
      </div>
    </Dialog>
  );
}

type Dispatch = ReturnType<typeof useGitSetup>["dispatch"];

function Steps({ current }: { current: number }) {
  const t = useT();
  return (
    <ol className="gs-steps" aria-label={t("gitsetup.stepOf", { n: Math.min(current + 1, WIZARD_STEPS.length), total: WIZARD_STEPS.length })}>
      {WIZARD_STEPS.map((step, i) => (
        <li key={step} className={i === current ? "on" : i < current ? "done" : ""} aria-current={i === current ? "step" : undefined}>
          <span className="gs-step-num" aria-hidden>
            {i < current ? <Check size={11} strokeWidth={2.5} /> : i + 1}
          </span>
          {t(`gitsetup.step.${step}` as TKey)}
        </li>
      ))}
    </ol>
  );
}

function ProviderStep({ s, dispatch, onEnter }: { s: WizardState; dispatch: Dispatch; onEnter: (e: React.KeyboardEvent) => void }) {
  const t = useT();
  const pasted = pastedOf(s);
  return (
    <div className="gs-stack">
      <div className="gs-providers" role="radiogroup" aria-label={t("gitsetup.provider.question")}>
        {PROVIDERS.map((p, i) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={s.provider === p}
            tabIndex={s.provider === p || (!s.provider && i === 0) ? 0 : -1}
            className={`gs-provider ${s.provider === p ? "on" : ""}`}
            data-provider={p}
            data-autofocus={s.provider === p || (!s.provider && i === 0) ? true : undefined}
            onClick={() => dispatch({ type: "provider", provider: p })}
            onKeyDown={(e) => {
              const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              const n = (i + d + PROVIDERS.length) % PROVIDERS.length;
              dispatch({ type: "provider", provider: PROVIDERS[n] });
              ((e.currentTarget.parentElement?.children[n] as HTMLElement | undefined) ?? null)?.focus();
            }}
          >
            <span className="gs-mark" aria-hidden>
              {p === "other" ? <Server size={15} /> : MARK[p]}
            </span>
            <span className="gs-provider-text">
              <span className="gs-provider-name">{t(`gitsetup.provider.${p}`)}</span>
              <span className="gs-provider-sub">{t(`gitsetup.provider.${p}Desc`)}</span>
            </span>
          </button>
        ))}
      </div>
      {s.provider && hasApi(s.provider) && (
        <Field label={t("gitsetup.server")} hint={s.provider === "gitea" ? t("gitsetup.serverNeeded") : t("gitsetup.serverOwn", { host: defaultWeb(s.provider).replace(/^https:\/\//, "") })}>
          <Input value={s.web} onChange={(e) => dispatch({ type: "web", web: e.target.value })} onKeyDown={onEnter} placeholder={defaultWeb(s.provider) || t("gitsetup.serverPlaceholder")} aria-label={t("gitsetup.server")} className="grow" inputMode="url" />
        </Field>
      )}
      <Field label={t("gitsetup.paste")} hint={t("gitsetup.pasteHint")}>
        <Input value={s.pasted} onChange={(e) => dispatch({ type: "paste", text: e.target.value })} onKeyDown={onEnter} placeholder={t("gitsetup.pastePlaceholder")} aria-label={t("gitsetup.paste")} className="grow" inputMode="url" />
      </Field>
      {s.pasted.trim() && <PastedNote parsed={pasted} onHttps={(https) => dispatch({ type: "paste", text: https })} />}
    </div>
  );
}

/** What the pasted address names; for an SSH address the HTTPS one to use instead. */
function PastedNote({ parsed, onHttps }: { parsed: ParsedAddress | null; onHttps: (https: string) => void }) {
  const t = useT();
  if (!parsed) return <p className="gs-note gs-note-warn" role="status">{t("gitsetup.pasteInvalid")}</p>;
  if (parsed.ssh && parsed.https) {
    const https = parsed.https;
    return (
      <div className="gs-callout gs-callout-warn" role="status">
        <TriangleAlert size={16} aria-hidden />
        <div>
          <p>{t("gitsetup.sshNote", { https })}</p>
          <Button size="sm" onClick={() => onHttps(https)}>
            {t("gitsetup.useHttps")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <p className="gs-note" role="status">
      <Check size={13} aria-hidden /> {parsed.owner ? t("gitsetup.pasteFound", { repo: `${parsed.owner}/${parsed.name}`, host: parsed.host }) : t("gitsetup.pasteServer", { host: parsed.host })}
    </p>
  );
}

function TokenStep({ s, dispatch, onEnter, openTokenPage }: { s: WizardState; dispatch: Dispatch; onEnter: (e: React.KeyboardEvent) => void; openTokenPage: (fineGrained?: boolean) => void }) {
  const t = useT();
  const [show, setShow] = useState(false);
  const note = tokenNote(s);
  const provider = s.provider ?? "other";
  return (
    <div className="gs-stack">
      <p className="gs-text">{t(`gitsetup.token.${provider}`)}</p>
      {hasApi(provider) && (
        <div className="gs-row">
          <Button icon={ExternalLink} onClick={() => openTokenPage()} className="gs-token-page">
            {t("gitsetup.token.open")}
          </Button>
          {provider === "github" && (
            <Button variant="ghost" onClick={() => openTokenPage(true)}>
              {t("gitsetup.token.githubFineLink")}
            </Button>
          )}
        </div>
      )}
      {provider === "github" && <p className="gs-text faint">{t("gitsetup.token.githubFine")}</p>}
      <Field label={t("gitsetup.token.label")} hint={t(note.key, { host: note.host })}>
        <div className="key-input grow">
          <KeyRound size={14} className="faint" />
          <input
            type={show ? "text" : "password"}
            value={s.token}
            onChange={(e) => dispatch({ type: "token", token: e.target.value })}
            onKeyDown={onEnter}
            placeholder={note.reuse ? t("set.git.tokenReplace") : t("gitsetup.token.placeholder")}
            aria-label={t("gitsetup.token.label")}
            autoComplete="off"
            spellCheck={false}
            data-autofocus
          />
          <IconButton icon={show ? EyeOff : Eye} label={show ? t("common.hide") : t("common.show")} size="sm" onClick={() => setShow(!show)} />
        </div>
      </Field>
      {s.busy === "account" && (
        <p className="gs-note" role="status">
          <Loader2 size={13} className="spin" aria-hidden /> {t("gitsetup.token.checking")}
        </p>
      )}
    </div>
  );
}

function RepoStep({ s, dispatch, onEnter }: { s: WizardState; dispatch: Dispatch; onEnter: (e: React.KeyboardEvent) => void }) {
  const t = useT();
  const provider = s.provider ?? "other";
  const list = s.repos ? filterRepos(s.repos, s.query) : null;
  const address = addressOf(s);
  return (
    <div className="gs-stack">
      {s.account && (
        <p className="gs-note" role="status">
          <CheckCircle2 size={13} aria-hidden /> {t("gitsetup.token.signedIn", { login: s.account.login })}
          {s.account.expires ? ` · ${t("gitsetup.token.expires", { date: fmtDate(`${s.account.expires.slice(0, 10)}T12:00:00`) })}` : ""}
        </p>
      )}
      {hasApi(provider) && (
        <Segmented
          label={t("gitsetup.step.repo")}
          value={s.mode}
          onChange={(mode) => dispatch({ type: "mode", mode })}
          options={[
            { value: "pick", label: t("gitsetup.repo.pick") },
            ...(canCreate(provider) ? [{ value: "create" as const, label: t("gitsetup.repo.create") }] : []),
            { value: "address", label: t("gitsetup.repo.address") },
          ]}
        />
      )}
      {hasApi(provider) && s.mode === "pick" && (
        <div className="gs-pick">
          <div className="gs-search">
            <Search size={14} className="faint" aria-hidden />
            <input value={s.query} onChange={(e) => dispatch({ type: "query", query: e.target.value })} onKeyDown={onEnter} placeholder={t("gitsetup.repo.search")} aria-label={t("gitsetup.repo.search")} spellCheck={false} data-autofocus />
            {list && <span className="gs-count faint">{t("gitsetup.repo.count", { n: list.length })}</span>}
          </div>
          {s.busy === "repos" || !list ? (
            <Skeleton rows={5} />
          ) : list.length ? (
            <div className="gs-repos" role="listbox" aria-label={t("gitsetup.step.repo")}>
              {list.slice(0, 200).map((r) => {
                const on = s.picked?.full_name === r.full_name;
                return (
                  <button key={r.full_name} type="button" role="option" aria-selected={on} className={`gs-repo ${on ? "on" : ""}`} onClick={() => dispatch({ type: "pick", repo: r })} onDoubleClick={() => dispatch({ type: "goto", step: "check" })}>
                    <span className="gs-repo-name">{r.full_name}</span>
                    <span className="gs-repo-badges">
                      {r.can_push === false && <Badge tone="warning">{t("gitsetup.repo.readOnly")}</Badge>}
                      {r.empty && <Badge>{t("gitsetup.repo.empty")}</Badge>}
                      <Badge>{r.private ? t("gitsetup.repo.private") : t("gitsetup.repo.public")}</Badge>
                    </span>
                    {r.description && <span className="gs-repo-desc">{r.description}</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="gs-note">{t("gitsetup.repo.none")}</p>
          )}
        </div>
      )}
      {hasApi(provider) && s.mode === "create" && (
        <Field label={t("gitsetup.repo.newName")} hint={s.account ? t("gitsetup.repo.newHint", { login: s.account.login }) : t("gitsetup.repo.newHintPlain")}>
          <Input value={s.newName} onChange={(e) => dispatch({ type: "name", name: e.target.value })} onKeyDown={onEnter} aria-label={t("gitsetup.repo.newName")} className="grow" data-autofocus />
        </Field>
      )}
      {(s.mode === "address" || !hasApi(provider)) && (
        <>
          <Field label={t("gitsetup.repo.addressLabel")} hint={hasApi(provider) ? t("gitsetup.repo.addressHint") : t("gitsetup.repo.addressHintOther")}>
            <Input value={s.address} onChange={(e) => dispatch({ type: "address", address: e.target.value })} onKeyDown={onEnter} placeholder={hasApi(provider) ? `${defaultWeb(provider) || t("gitsetup.serverPlaceholder")}/${t("gitsetup.repo.placeholderPath")}` : t("gitsetup.repo.addressPlaceholder")} aria-label={t("gitsetup.repo.addressLabel")} className="grow" inputMode="url" data-autofocus />
          </Field>
          {s.address.trim() && address?.ssh && <PastedNote parsed={address} onHttps={(https) => dispatch({ type: "address", address: https })} />}
        </>
      )}
      {s.reposProblem && (
        <div className="gs-callout gs-callout-warn" role="status">
          <TriangleAlert size={16} aria-hidden />
          <div>
            <p>
              <strong>{t("gitsetup.repo.listFailed")}</strong> {t(problemKeys(s.reposProblem.kind).title, { status: s.reposProblem.status ?? "" })}
            </p>
            <p className="faint">{t("gitsetup.repo.listFailedFix")}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function StepIcon({ state, busy }: { state: string; busy: boolean }) {
  if (busy) return <Loader2 size={15} className="spin faint" aria-hidden />;
  if (state === "ok") return <CheckCircle2 size={15} className="gs-ok" aria-hidden />;
  if (state === "fail") return <XCircle size={15} className="gs-fail" aria-hidden />;
  if (state === "unknown") return <CircleMinus size={15} className="faint" aria-hidden />;
  return <CircleDashed size={15} className="faint" aria-hidden />;
}

function CheckStep({ s, provider, onGoto }: { s: WizardState; provider: GitProvider; onGoto: (step: "token" | "repo") => void }) {
  const t = useT();
  const running = s.busy === "check" || (!s.check && !s.problem);
  const ids = hasApi(provider) ? (["server", "token", "repository", "write", "git", "branch"] as const) : (["git", "write", "branch"] as const);
  const steps = s.check?.steps ?? ids.map((id) => ({ id, state: "skipped" as const }));
  const content = s.check && !s.check.problem ? contentKey(s.check) : null;
  const tokenKinds = ["token_missing", "token_invalid", "token_expired", "token_scope"];
  const repoKinds = ["not_found", "no_write", "ssh"];
  return (
    <div className="gs-stack">
      <p className="gs-text">
        {t("gitsetup.check.intro", { repo: targetName(s) })}
      </p>
      <ul className="gs-checks" aria-busy={running}>
        {steps.map((st) => (
          <li key={st.id} className={`gs-check gs-check-${st.state}`} data-step={st.id} data-state={running ? "running" : st.state}>
            <StepIcon state={st.state} busy={running} />
            <span>{st.id === "branch" && st.state === "ok" && s.check?.branch ? t("gitsetup.check.branchIs", { branch: s.check.branch }) : t(stepKey(st.id, st.state, provider))}</span>
          </li>
        ))}
      </ul>
      {s.problem && !running && (
        <ProblemNote problem={s.problem} provider={provider} https={addressOf(s)?.https ?? null}>
          {tokenKinds.includes(s.problem.kind) && (
            <Button size="sm" onClick={() => onGoto("token")}>
              {t("gitsetup.check.changeToken")}
            </Button>
          )}
          {repoKinds.includes(s.problem.kind) && (
            <Button size="sm" onClick={() => onGoto("repo")}>
              {t("gitsetup.check.otherRepo")}
            </Button>
          )}
        </ProblemNote>
      )}
      {content && (
        <div className="gs-callout" role="status">
          <Info size={16} aria-hidden />
          <p>{t(content, { branch: s.check?.branch ?? "" })}</p>
        </div>
      )}
    </div>
  );
}

/** A problem in plain words with its fix, the technical detail folded away. */
function ProblemNote({ problem, provider, https, creating, children }: { problem: SetupProblem; provider: GitProvider; https: string | null; creating?: boolean; children?: ReactNode }) {
  const t = useT();
  const keys = problemKeys(problem.kind);
  const vars = { scopes: scopesFor(provider, !!creating), https: https ?? "https://…", status: problem.status ?? "", detail: problem.detail };
  return (
    <div className="gs-callout gs-callout-error gs-problem" role="alert" data-kind={problem.kind}>
      <TriangleAlert size={16} aria-hidden />
      <div>
        <p className="gs-problem-title">{t(keys.title, vars)}</p>
        <p>{t(keys.fix, vars)}</p>
        {problem.detail && (
          <details className="gs-detail">
            <summary>{t("gitsetup.details")}</summary>
            <code>{problem.detail}</code>
          </details>
        )}
        {children && <div className="gs-row">{children}</div>}
      </div>
    </div>
  );
}
