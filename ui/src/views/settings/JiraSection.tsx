// Settings → Jira: sites (Cloud with e-mail and API token, Server/Data Center with a personal
// access token; tokens go to the credential store), saved JQL searches, the sync, and which
// Netzplan/Vorgang an issue or project books on. Sites are saved by their own commands, the
// other rows with the settings (at once).

import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { on } from "../../lib/api";
import { useApp } from "../../store/app";
import { relative } from "../../lib/format";
import {
  Badge,
  Button,
  Dialog,
  Field,
  IconButton,
  Input,
  Segmented,
  Select,
  Switch,
  useMenu,
} from "../../components/ui";
import { useT, type TKey } from "../../lib/i18n";
import {
  DEFAULT_JQL,
  isSiteAddress,
  jiraApi,
  type IssueSettings,
  type JiraSite,
  type JiraStatus,
  type SiteInfo,
  type SiteKind,
  type TestResult,
} from "../../lib/jira";
import { useTimeTracking } from "../../lib/timetracking";
import {
  Group,
  NumberInput,
  Row,
  StatusNote,
  Unfiltered,
  type SectionProps,
} from "./common";

const COLORS = [
  "#2563eb",
  "#0d9488",
  "#9333ea",
  "#ea580c",
  "#db2777",
  "#65a30d",
  "#0891b2",
  "#ca8a04",
];
const COLOR_NAMES: TKey[] = [
  "calset.color.blue",
  "calset.color.petrol",
  "calset.color.violet",
  "calset.color.orange",
  "calset.color.pink",
  "calset.color.green",
  "calset.color.cyan",
  "calset.color.gold",
];

export const DEFAULT_JIRA: IssueSettings = {
  sites: [],
  queries: [],
  sync_minutes: 10,
  tick_done_tasks: true,
};

/** The kind a site address suggests (same rule as arcalo_core::issues::SiteKind::guess). */
export function guessKind(url: string): SiteKind {
  const host = url
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .split(/[/:?#]/)[0]
    .toLowerCase();
  return /\.(atlassian\.net|jira\.com|atlassian\.com)$/.test(host)
    ? "cloud"
    : "server";
}

function SiteStatus({ site }: { site: SiteInfo }) {
  const t = useT();
  if (site.syncing)
    return <StatusNote tone="busy">{t("jira.set.syncing")}</StatusNote>;
  if (!site.enabled) return <StatusNote>{t("calset.off")}</StatusNote>;
  if (!site.token_set)
    return <StatusNote tone="warning">{t("jira.set.noToken")}</StatusNote>;
  if (site.sync?.error)
    return <StatusNote tone="danger">{site.sync.error}</StatusNote>;
  if (site.sync?.synced_at)
    return (
      <StatusNote tone="success">
        {t("jira.set.synced", {
          n: site.sync.issues,
          when: relative(site.sync.synced_at),
          name: site.sync.account || "–",
        })}
      </StatusNote>
    );
  return <StatusNote>{t("calset.notSynced")}</StatusNote>;
}

export function JiraSection({ draft, update }: SectionProps) {
  const t = useT();
  const timeOn = useTimeTracking();
  const jira = draft.jira ?? DEFAULT_JIRA;
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [editing, setEditing] = useState<SiteInfo | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, , openMenuAt] = useMenu();
  const s = useApp.getState;
  const set = (p: Partial<IssueSettings>) =>
    update({ jira: { ...jira, ...p } });

  useEffect(() => {
    const load = () =>
      jiraApi
        .status()
        .then(setStatus)
        .catch(() => {});
    load();
    const offs = [
      on("jira://synced", load),
      on("jira://syncing", load),
      on("settings://changed", load),
    ];
    return () => offs.forEach((u) => u.then((f) => f()));
  }, []);

  const run = async (fn: () => Promise<JiraStatus>, ok?: string) => {
    setBusy(true);
    try {
      setStatus(await fn());
      await s().refreshSettings();
      if (ok) s().toast({ tone: "success", title: ok });
      return true;
    } catch (e) {
      s().error(t("jira.set.title"), e);
      jiraApi
        .status()
        .then(setStatus)
        .catch(() => {});
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sites = status?.sites ?? [];
  const siteMenu = (site: SiteInfo) => [
    {
      label: t("calset.syncNow"),
      icon: RefreshCw,
      onSelect: () =>
        void run(
          () => jiraApi.syncNow(site.id),
          t("jira.set.syncedToast", { name: site.name }),
        ),
    },
    {
      label: t("jira.set.edit"),
      icon: Pencil,
      onSelect: () => setEditing(site),
    },
    {
      label: t("links.color"),
      icon: Palette,
      submenu: COLORS.map((c, i) => ({
        label: t(COLOR_NAMES[i]),
        checked: c === site.color,
        onSelect: () =>
          void run(() => jiraApi.saveSite({ ...site, color: c }, null)),
      })),
    },
    "separator" as const,
    {
      label: t("common.remove"),
      icon: Trash2,
      danger: true,
      onSelect: async () => {
        if (
          !(await s().confirm({
            title: t("jira.set.removeAsk", { name: site.name }),
            message: t("jira.set.removeText"),
            confirmLabel: t("common.remove"),
            danger: true,
          }))
        )
          return;
        void run(() => jiraApi.removeSite(site.id), t("jira.set.removed"));
      },
    },
  ];

  return (
    <>
      <header className="settings-head">
        <h1>{t("jira.set.title")}</h1>
        <p>{t("jira.set.intro")}</p>
      </header>

      <Group title={t("jira.set.sites")} description={t("jira.set.sitesDesc")}>
        <Unfiltered>
          <div
            className="calset-list jira-sites"
            aria-label={t("jira.set.sites")}
          >
            {sites.length === 0 && (
              <div className="calset-empty faint">{t("jira.set.none")}</div>
            )}
            {sites.map((site) => (
              <div
                key={site.id}
                className={`calset-item ${site.enabled ? "" : "off"}`}
                data-site={site.id}
              >
                <span
                  className="calset-color"
                  style={{ background: site.color }}
                  aria-hidden
                />
                <div className="calset-text">
                  <div className="calset-name">
                    <span className="ellipsis">{site.name}</span>
                    <Badge>
                      {site.kind === "cloud"
                        ? t("jira.set.cloud")
                        : t("jira.set.server")}
                    </Badge>
                  </div>
                  <div className="calset-where faint mono ellipsis">
                    {site.url}
                  </div>
                  <SiteStatus site={site} />
                </div>
                <Switch
                  label={t("jira.set.syncSite", { name: site.name })}
                  checked={site.enabled}
                  onChange={(v) =>
                    void run(() =>
                      jiraApi.saveSite({ ...site, enabled: v }, null),
                    )
                  }
                />
                <IconButton
                  icon={MoreHorizontal}
                  label={t("calset.actionsFor", { name: site.name })}
                  onClick={(e) => openMenuAt(e, siteMenu(site))}
                />
              </div>
            ))}
          </div>
          <div className="calset-add">
            <Button
              icon={Plus}
              onClick={() => setEditing("new")}
              disabled={busy}
            >
              {t("jira.set.add")}
            </Button>
          </div>
          <p className="calset-note faint">
            {t("jira.set.secretNote", {
              store: status?.secret_storage ?? t("calset.secretStore"),
            })}
          </p>
        </Unfiltered>
      </Group>

      {sites.length > 0 && (
        <Queries
          jira={jira}
          sites={sites}
          set={set}
          errors={status?.query_errors ?? {}}
        />
      )}

      <Group title={t("calset.sync")}>
        <Row
          label={t("calset.interval")}
          description={t("jira.set.intervalDesc")}
        >
          <div className="unit-input">
            <NumberInput
              min={1}
              max={1440}
              value={jira.sync_minutes}
              onCommit={(v) => set({ sync_minutes: v })}
              aria-label={t("unit.minutes")}
            />
            <span className="faint">{t("unit.minutes")}</span>
          </div>
        </Row>
        <Row label={t("jira.set.tick")} description={t("jira.set.tickDesc")}>
          <Switch
            label={t("jira.set.tick")}
            checked={jira.tick_done_tasks}
            onChange={(v) => set({ tick_done_tasks: v })}
          />
        </Row>
        <Row label={t("jira.set.syncAll")}>
          <Button
            icon={RefreshCw}
            loading={busy || sites.some((x) => x.syncing)}
            disabled={!sites.length}
            onClick={() =>
              void run(() => jiraApi.syncNow(), t("jira.set.syncedAll"))
            }
          >
            {t("calset.syncNow")}
          </Button>
        </Row>
      </Group>

      {timeOn && status && <Mappings status={status} setStatus={setStatus} />}

      <Unfiltered>
        <details className="calset-help">
          <summary>{t("jira.set.help")}</summary>
          <ul>
            <li>{t("jira.set.help1")}</li>
            <li>{t("jira.set.help2")}</li>
            <li>{t("jira.set.help3")}</li>
            <li>{t("jira.set.help4")}</li>
          </ul>
        </details>
      </Unfiltered>

      {editing && (
        <SiteDialog
          site={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (site, token) => {
            const ok = await run(
              () => jiraApi.saveSite(site, token),
              editing === "new" ? t("jira.set.added") : t("jira.set.saved"),
            );
            if (ok) setEditing(null);
          }}
        />
      )}
      {menu}
    </>
  );
}

function Queries({
  jira,
  sites,
  set,
  errors,
}: {
  jira: IssueSettings;
  sites: SiteInfo[];
  set: (p: Partial<IssueSettings>) => void;
  /** Searches that failed in the last sync (query id → message). */
  errors: Record<string, string>;
}) {
  const t = useT();
  const [site, setSite] = useState(sites[0]?.id ?? "");
  const [name, setName] = useState("");
  const [jql, setJql] = useState("");
  const siteName = (id: string) => sites.find((x) => x.id === id)?.name ?? id;
  const add = () => {
    if (!jql.trim()) return;
    set({
      queries: [
        ...jira.queries,
        {
          id: "",
          site: site || sites[0].id,
          name: name.trim(),
          jql: jql.trim(),
        },
      ],
    });
    setName("");
    setJql("");
  };
  return (
    <Group
      title={t("jira.set.queries")}
      description={t("jira.set.queriesDesc")}
    >
      <Row
        label={t("jira.set.defaultQuery")}
        description={t("jira.set.defaultQueryDesc")}
      >
        <code className="jira-jql">{DEFAULT_JQL}</code>
      </Row>
      <Unfiltered>
        <div className="jira-queries" aria-label={t("jira.set.queries")}>
          {jira.queries.map((q) => (
            <div key={q.id} className="jira-query" data-query={q.id}>
              <div className="jira-query-text">
                <div className="jira-query-name">
                  <span className="ellipsis">{q.name}</span>
                  {sites.length > 1 && (
                    <span className="faint small">{siteName(q.site)}</span>
                  )}
                </div>
                <code className="jira-jql ellipsis" title={q.jql}>
                  {q.jql}
                </code>
                {errors[q.id] && (
                  <div className="jira-query-error" role="status">
                    <AlertCircle size={13} aria-hidden />
                    <span>
                      {t("jira.set.queryFailed", { error: errors[q.id] })}
                    </span>
                  </div>
                )}
              </div>
              <IconButton
                icon={X}
                size="sm"
                label={t("jira.set.removeQuery", { name: q.name })}
                onClick={() =>
                  set({ queries: jira.queries.filter((x) => x.id !== q.id) })
                }
              />
            </div>
          ))}
          <div className="jira-query-add">
            {sites.length > 1 && (
              <Select
                aria-label={t("jira.f.site")}
                value={site}
                onChange={(e) => setSite(e.target.value)}
                options={sites.map((x) => ({ value: x.id, label: x.name }))}
              />
            )}
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("jira.set.queryName")}
              aria-label={t("jira.set.queryName")}
              className="jira-query-name-input"
            />
            <Input
              value={jql}
              onChange={(e) => setJql(e.target.value)}
              placeholder={t("jira.set.jqlPh")}
              aria-label={t("jira.set.jql")}
              className="mono grow"
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <Button icon={Plus} onClick={add} disabled={!jql.trim()}>
              {t("common.add")}
            </Button>
          </div>
        </div>
      </Unfiltered>
    </Group>
  );
}

function Mappings({
  status,
  setStatus,
}: {
  status: JiraStatus;
  setStatus: (s: JiraStatus) => void;
}) {
  const t = useT();
  const [key, setKey] = useState("");
  const [reference, setReference] = useState("");
  const s = useApp.getState;
  const save = async (k: string, ref: string) => {
    const kk = k.trim().toUpperCase();
    const kind = /-\d+$/.test(kk) ? "issue" : "project";
    try {
      setStatus(await jiraApi.setWbs(kind, kk, ref.trim()));
      return true;
    } catch (e) {
      s().error(t("jira.set.mapFailed"), e);
      return false;
    }
  };
  return (
    <Group
      title={t("jira.set.mapping")}
      description={t("jira.set.mappingDesc")}
    >
      <Unfiltered>
        <div className="jira-mappings" aria-label={t("jira.set.mapping")}>
          {status.mappings.length === 0 && (
            <div className="calset-empty faint">{t("jira.set.noMappings")}</div>
          )}
          {status.mappings.map((m) => (
            <div
              key={`${m.kind}:${m.key}`}
              className="jira-mapping"
              data-map={m.key}
            >
              <Badge tone={m.kind === "issue" ? "info" : "neutral"}>
                {m.kind === "issue"
                  ? t("jira.set.mapIssue")
                  : t("jira.set.mapProject")}
              </Badge>
              <span className="mono">{m.key}</span>
              <span className="faint" aria-hidden>
                →
              </span>
              <span className="mono grow">{m.reference}</span>
              {m.learned && (
                <span className="faint small">{t("jira.set.learned")}</span>
              )}
              <IconButton
                icon={X}
                size="sm"
                label={t("jira.set.removeMap", { key: m.key })}
                onClick={() => void save(m.key, "")}
              />
            </div>
          ))}
          <div className="jira-query-add">
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t("jira.set.mapKeyPh")}
              aria-label={t("jira.set.mapKey")}
              className="mono"
              spellCheck={false}
            />
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("jira.set.mapRefPh")}
              aria-label={t("jira.set.mapRef")}
              className="mono grow"
              spellCheck={false}
            />
            <Button
              icon={Plus}
              disabled={!key.trim() || !reference.trim()}
              onClick={async () => {
                if (await save(key, reference)) (setKey(""), setReference(""));
              }}
            >
              {t("common.add")}
            </Button>
          </div>
        </div>
      </Unfiltered>
    </Group>
  );
}

function SiteDialog({
  site,
  onClose,
  onSave,
}: {
  site: SiteInfo | null;
  onClose: () => void;
  onSave: (site: JiraSite, token: string | null) => Promise<void>;
}) {
  const t = useT();
  const timeOn = useTimeTracking();
  const [s, setS] = useState<JiraSite>(
    () =>
      site ?? {
        id: "",
        name: "",
        color: "",
        kind: "cloud",
        url: "",
        email: "",
        enabled: true,
        log_work: false,
        allow_writes: false,
      },
  );
  const [kindTouched, setKindTouched] = useState(!!site);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<
    { ok: TestResult } | { error: string } | null
  >(null);
  const cloud = s.kind === "cloud";
  const patch = (p: Partial<JiraSite>) => (
    setS((old) => ({ ...old, ...p })),
    setTest(null)
  );
  const valid =
    isSiteAddress(s.url) &&
    (!cloud || s.email.includes("@")) &&
    (!!token.trim() || !!site?.token_set);

  const runTest = async () => {
    setBusy(true);
    try {
      const r = await jiraApi.test(s, token.trim() || null);
      // The server said what it is: take that over.
      if (r.kind !== s.kind) setS((old) => ({ ...old, kind: r.kind }));
      setTest({ ok: r });
    } catch (e) {
      setTest({ error: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        site ? t("jira.set.editTitle", { name: site.name }) : t("jira.set.add")
      }
      description={t("jira.set.dialogDesc")}
      width={560}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => void runTest()}
            loading={busy}
            disabled={!valid}
            className="jira-test"
          >
            {t("jira.set.test")}
          </Button>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() =>
              void onSave(
                {
                  ...s,
                  name:
                    s.name.trim() ||
                    s.url.replace(/^https?:\/\//, "").split("/")[0],
                },
                token.trim() || null,
              )
            }
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Field label={t("jira.set.url")} hint={t("jira.set.urlHint")}>
        <Input
          value={s.url}
          data-autofocus
          spellCheck={false}
          aria-label={t("jira.set.url")}
          placeholder="https://firma.atlassian.net"
          onChange={(e) =>
            patch({
              url: e.target.value,
              ...(kindTouched ? {} : { kind: guessKind(e.target.value) }),
            })
          }
        />
      </Field>
      <Field label={t("jira.set.kind")}>
        <Segmented
          label={t("jira.set.kind")}
          value={s.kind}
          options={[
            { value: "cloud", label: t("jira.set.cloud") },
            { value: "server", label: t("jira.set.server") },
          ]}
          onChange={(v: SiteKind) => (setKindTouched(true), patch({ kind: v }))}
        />
      </Field>
      {cloud && (
        <Field label={t("jira.set.email")}>
          <Input
            value={s.email}
            type="email"
            spellCheck={false}
            aria-label={t("jira.set.email")}
            placeholder={t("jira.set.emailPh")}
            onChange={(e) => patch({ email: e.target.value })}
          />
        </Field>
      )}
      <Field
        label={cloud ? t("jira.set.apiToken") : t("jira.set.pat")}
        hint={cloud ? t("jira.set.apiTokenHint") : t("jira.set.patHint")}
      >
        <Input
          value={token}
          type="password"
          autoComplete="off"
          aria-label={cloud ? t("jira.set.apiToken") : t("jira.set.pat")}
          placeholder={site?.token_set ? t("jira.set.tokenKept") : ""}
          onChange={(e) => (setToken(e.target.value), setTest(null))}
        />
      </Field>
      <Field label={t("links.name")}>
        <Input
          value={s.name}
          aria-label={t("links.name")}
          placeholder={t("jira.set.namePh")}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>
      <div className="jira-switches">
        {timeOn && (
          <label className="jira-switch">
            <Switch
              label={t("jira.set.logWork")}
              checked={s.log_work}
              onChange={(v) => patch({ log_work: v })}
            />
            <span>
              <b>{t("jira.set.logWork")}</b>
              <span className="faint small">{t("jira.set.logWorkDesc")}</span>
            </span>
          </label>
        )}
        <label className="jira-switch">
          <Switch
            label={t("jira.set.writes")}
            checked={s.allow_writes}
            onChange={(v) => patch({ allow_writes: v })}
          />
          <span>
            <b>{t("jira.set.writes")}</b>
            <span className="faint small">{t("jira.set.writesDesc")}</span>
          </span>
        </label>
      </div>
      {test && (
        <div
          className={`jira-test-result ${"ok" in test ? "ok" : "bad"}`}
          role="status"
        >
          {"ok" in test ? (
            <>
              <CheckCircle2 size={15} aria-hidden />
              <span>
                {t("jira.set.testOk", { name: test.ok.display_name })}
                {test.ok.detected && (
                  <span className="faint">
                    {" "}
                    ·{" "}
                    {test.ok.detected === "cloud"
                      ? t("jira.set.cloud")
                      : t("jira.set.server")}
                  </span>
                )}
              </span>
            </>
          ) : (
            <>
              <AlertCircle size={15} aria-hidden />
              <span>{test.error}</span>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
