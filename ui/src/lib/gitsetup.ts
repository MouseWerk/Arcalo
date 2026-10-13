// The guided setup of the Git sync, shared by the desktop's dialog (views/settings/GitSetupWizard)
// and the phone's screen (mobile/screens/GitSetup): the providers, the address parser (what
// people paste: repository pages, `.git` or not, SSH addresses), the token pages with the scopes
// preselected, and the wizard's state as a reducer. The requests are the shell's `git_setup_*`
// commands (src-tauri/src/gitsetup.rs); saving goes through the settings and `git_token_set`.

import type { TKey } from "./i18n";

export type GitProvider = "github" | "gitlab" | "gitea" | "bitbucket" | "other";

export const PROVIDERS: GitProvider[] = ["github", "gitlab", "gitea", "bitbucket", "other"];

/** Where a provider lives; `web` is its web address (a path prefix is kept). */
export interface GitServer {
  provider: GitProvider;
  web: string;
}

export type ProblemKind =
  | "token_missing"
  | "token_invalid"
  | "token_expired"
  | "token_scope"
  | "no_write"
  | "not_found"
  | "exists"
  | "bad_name"
  | "bad_address"
  | "rate_limited"
  | "proxy"
  | "certificate"
  | "unreachable"
  | "timeout"
  | "ssh"
  | "git_missing"
  | "not_api"
  | "server"
  | "other";

export interface SetupProblem {
  kind: ProblemKind;
  status: number | null;
  /** Technical detail (redacted), for „Details“. */
  detail: string;
}

export interface SetupAnswer<T> {
  value: T | null;
  problem: SetupProblem | null;
}

export interface SetupAccount {
  login: string;
  name: string | null;
  expires: string | null;
  scopes: string[] | null;
}

export interface SetupRepo {
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  web_url: string;
  default_branch: string | null;
  empty: boolean | null;
  can_push: boolean | null;
  updated: string | null;
  description: string | null;
}

export type StepId = "server" | "token" | "repository" | "write" | "git" | "branch";
export type StepState = "ok" | "unknown" | "fail" | "skipped";
export type Content = "empty" | "arcalo" | "other" | "unknown";

export interface SetupCheck {
  steps: { id: StepId; state: StepState }[];
  problem: SetupProblem | null;
  account: SetupAccount | null;
  branch: string | null;
  default_branch: string | null;
  branches: string[];
  content: Content | null;
  write: boolean | null;
}

/** The repository the check gets: the address git uses, and on a provider owner and name. */
export interface SetupTarget {
  url: string;
  owner: string | null;
  name: string | null;
}

/** The branch the setup proposes for a repository with other files (gitsetup.rs `OWN_BRANCH`). */
export const OWN_BRANCH = "arcalo";

// ------------------------------------------------------------------ providers

/** The web address used when the field is left empty (`""`: the provider needs one). */
export function defaultWeb(p: GitProvider): string {
  return p === "github" ? "https://github.com" : p === "gitlab" ? "https://gitlab.com" : p === "bitbucket" ? "https://bitbucket.org" : "";
}

/** The provider has a REST API Arcalo uses (lists, creates and checks repositories). */
export const hasApi = (p: GitProvider) => p !== "other";

/** Arcalo can create a repository there. Not on Bitbucket: its access tokens (of a repository,
 *  project or workspace, the kind the sync signs in with) stand for no user and cannot. */
export const canCreate = (p: GitProvider) => hasApi(p) && p !== "bitbucket";

/** The scopes or permissions a token needs, as the provider names them (for the texts). */
export const SCOPES: Record<GitProvider, string> = {
  github: "repo",
  gitlab: "read_repository, write_repository, read_api",
  gitea: "write:repository, read:user",
  bitbucket: "repository:write",
  other: "",
};

/** The scopes a fix names: creating a GitLab project needs „api“ besides them. */
export const scopesFor = (provider: GitProvider, creating: boolean) => (provider === "gitlab" && creating ? "api" : SCOPES[provider]);

/** The provider a host belongs to, when its name says so. */
export function providerOfHost(host: string): GitProvider | null {
  const h = host.toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
  if (h === "github.com") return "github";
  if (h === "gitlab.com" || /(^|[.-])gitlab([.-]|$)/.test(h)) return "gitlab";
  if (h === "bitbucket.org") return "bitbucket";
  if (h === "codeberg.org" || /(^|[.-])(gitea|forgejo)([.-]|$)/.test(h)) return "gitea";
  return null;
}

/** A web address (`https://host[:port][/path]`) without user, query or trailing slash; `null`
 *  for anything else. An address without a scheme gets https. */
export function normalizeWeb(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!u.hostname || /[@\s]/.test(s.replace(/^https?:\/\/[^@/]*@/i, ""))) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/** An http(s) address without the user name and password in it (they are never shown or stored
 *  again: the token lives in the credential store). Anything else stays as it is. */
export function withoutCredentials(raw: string): string {
  const s = raw.trim();
  const m = /^(https?:\/\/)([^/@]*@)(.*)$/i.exec(s);
  return m ? `${m[1]}${m[3]}` : raw;
}

/** `scheme://host[:port]` of an http(s) address, `www.` ignored (`null` for anything else): the
 *  server a token is sent to. */
function serverKey(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host.toLowerCase().replace(/^www\./, "")}`;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ addresses

export interface ParsedAddress {
  /** The provider the host names (`null`: unknown, e.g. a company's own server). */
  provider: GitProvider | null;
  /** `https://host[:port]` (http only when it was pasted so). */
  web: string;
  host: string;
  /** Owner (GitLab: the full group path) and name, when the address names a repository. */
  owner: string | null;
  name: string | null;
  /** The HTTPS address git uses (`…/owner/name.git`), when a repository is named. */
  https: string | null;
  /** The input was an SSH address (`git@host:owner/name.git`, `ssh://…`). */
  ssh: boolean;
}

const SEGMENT = /^[A-Za-z0-9._~-]+$/;
/** Where a repository page's own part of the path starts (Gitea, Bitbucket, GitHub). */
const PAGE_PARTS = new Set(["src", "tree", "blob", "commits", "commit", "branches", "tags", "issues", "pulls", "pull", "wiki", "settings", "raw", "releases", "actions", "activity", "compare", "admin"]);

/**
 * What a pasted address names: the repository page in the browser (also deeper pages: a file, a
 * branch, issues), the address for `git clone` with or without `.git`, with a trailing slash, with
 * a user name (Bitbucket), an SSH address (`git@host:owner/name.git`, `ssh://git@host:22/…`), or
 * only a server. `hint` decides the path rules when the host does not name its provider (a GitLab
 * of a company: groups and subgroups). `null` when it is no address.
 */
export function parseAddress(raw: string, hint: GitProvider | null = null): ParsedAddress | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  let host: string;
  let path: string;
  let scheme = "https:";
  let ssh = false;
  const sshUrl = /^(?:ssh|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?(\[[^\]]+\]|[^/:]+)(?::\d+)?\/(.*)$/i.exec(s);
  // git's short form `user@host:path`; `host:path` only for a dotted host whose path is no port.
  const scp = s.includes("://") ? null : /^(?:([^@/:]+)@)?([^/:@]{2,}):(.+)$/.exec(s);
  const isScp = !!scp && (!!scp[1] || (scp[2].includes(".") && !/^\d+(\/|$)/.test(scp[3])));
  if (sshUrl) {
    [host, path, ssh] = [sshUrl[1], sshUrl[2], true];
  } else if (scp && isScp) {
    [host, path, ssh] = [scp[2], scp[3], true];
  } else {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null;
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      return null;
    }
    if (!u.hostname || !/^[a-z0-9.[\]:-]+$/i.test(u.host)) return null;
    // A bare word („notizen“) is no server.
    if (!/^https?:\/\//i.test(s) && !u.hostname.includes(".") && u.hostname !== "localhost") return null;
    [host, path, scheme] = [u.host, u.pathname, u.protocol];
  }
  host = host.toLowerCase();
  const web = `${scheme}//${host}`;
  const provider = providerOfHost(host);
  let segs = path
    .split(/[?#]/)[0]
    .split("/")
    .map((x) => {
      try {
        return decodeURIComponent(x);
      } catch {
        return x;
      }
    })
    .filter(Boolean);
  const rules = provider ?? hint;
  if (rules === "gitlab") {
    // GitLab: groups and subgroups, the project's own pages after „/-/“.
    const dash = segs.indexOf("-");
    if (dash >= 0) segs = segs.slice(0, dash);
  } else {
    const page = segs.findIndex((x, i) => i >= 2 && PAGE_PARTS.has(x));
    segs = segs.slice(0, page >= 0 ? page : 2);
  }
  if (segs.length >= 2) segs[segs.length - 1] = segs[segs.length - 1].replace(/\.git$/i, "");
  const named = segs.length >= 2 && segs.every((x) => SEGMENT.test(x)) && segs[segs.length - 1] !== "";
  const owner = named ? segs.slice(0, -1).join("/") : null;
  const name = named ? segs[segs.length - 1] : null;
  return { provider, web, host, owner, name, https: named ? `${web}/${owner}/${name}.git` : null, ssh };
}

// ------------------------------------------------------------------ token pages

/** The page where the token is created, with the needed scopes ticked where the provider takes
 *  them from the address (GitHub, GitLab). `null` for another server. */
export function tokenPage(provider: GitProvider, web: string, repo?: { owner: string | null; name: string | null } | null): string | null {
  const base = (normalizeWeb(web) ?? defaultWeb(provider)).replace(/\/+$/, "");
  if (!base) return null;
  switch (provider) {
    case "github":
      return `${base}/settings/tokens/new?scopes=repo&description=Arcalo`;
    case "gitlab":
      return `${base}/-/user_settings/personal_access_tokens?name=Arcalo&scopes=read_repository,write_repository,read_api`;
    case "gitea":
      return `${base}/user/settings/applications`;
    case "bitbucket":
      return repo?.owner && repo.name ? `${base}/${repo.owner}/${repo.name}/admin/access-tokens` : `${base}/account/workspaces/`;
    default:
      return null;
  }
}

/** GitHub's page for a fine-grained token (the repository and „Contents: Read and write“ are
 *  chosen there). */
export const fineGrainedPage = (web: string) => `${(normalizeWeb(web) ?? defaultWeb("github")).replace(/\/+$/, "")}/settings/personal-access-tokens/new`;

// ------------------------------------------------------------------ names

/** A name a new repository can have everywhere (gitsetup.rs `valid_repo_name`). */
export function validRepoName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= 100 && !/^[.-]/.test(n) && !/\.git$/i.test(n) && /^[A-Za-z0-9._-]+$/.test(n);
}

/** The repositories matching `query` (name, owner, description), in the server's order (newest first). */
export function filterRepos(repos: SetupRepo[], query: string): SetupRepo[] {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  const words = q.split(/\s+/);
  return repos.filter((r) => {
    const hay = `${r.full_name} ${r.description ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ------------------------------------------------------------------ wording

/** The catalog keys of a problem: what is wrong, and how to fix it. */
export function problemKeys(kind: ProblemKind): { title: TKey; fix: TKey } {
  return { title: `gitsetup.problem.${kind}` as TKey, fix: `gitsetup.fix.${kind}` as TKey };
}

/** What the first sync will do with the repository's content. */
export function contentKey(check: SetupCheck): TKey | null {
  switch (check.content) {
    case "empty":
      return "gitsetup.content.empty";
    case "arcalo":
      return "gitsetup.content.arcalo";
    case "other":
      return check.branch === OWN_BRANCH ? "gitsetup.content.other" : "gitsetup.content.otherFallback";
    case "unknown":
      return "gitsetup.content.unknown";
    default:
      return null;
  }
}

/** The label of a step of the check (another server: git proves server, token and repository). */
export function stepKey(id: StepId, state: StepState, provider: GitProvider): TKey {
  if (id === "write" && state === "unknown") return "gitsetup.check.writeUnknown";
  if (id === "token" && state === "unknown") return "gitsetup.check.tokenUnknown";
  if (id === "git" && !hasApi(provider)) return "gitsetup.check.gitOther";
  return `gitsetup.check.${id}` as TKey;
}

// ------------------------------------------------------------------ wizard

export type WizardStep = "provider" | "token" | "repo" | "check" | "done";
export const WIZARD_STEPS: WizardStep[] = ["provider", "token", "repo", "check"];
export type RepoMode = "pick" | "create" | "address";
export type Busy = null | "account" | "repos" | "create" | "check" | "save";

export interface WizardState {
  step: WizardStep;
  provider: GitProvider | null;
  /** The server's web address as typed (`""`: the provider's default). */
  web: string;
  /** An address pasted in the first step (optional). */
  pasted: string;
  /** The token typed into the setup (not saved before the end). */
  token: string;
  /** A token is in the credential store already (used when the field stays empty, on the server
   *  of the saved repository only). */
  tokenStored: boolean;
  /** The saved repository's address (without user name and password), `""` when none. */
  savedRemote: string;
  account: SetupAccount | null;
  repos: SetupRepo[] | null;
  /** Why the list could not be loaded (the address field stays). */
  reposProblem: SetupProblem | null;
  query: string;
  mode: RepoMode;
  picked: SetupRepo | null;
  newName: string;
  /** The repository's address typed in the third step. */
  address: string;
  check: SetupCheck | null;
  busy: Busy;
  /** The problem of the current step. */
  problem: SetupProblem | null;
}

export type WizardAction =
  | { type: "provider"; provider: GitProvider }
  | { type: "web"; web: string }
  | { type: "paste"; text: string }
  | { type: "token"; token: string }
  | { type: "busy"; busy: Busy }
  | { type: "problem"; problem: SetupProblem | null }
  | { type: "account"; answer: SetupAnswer<SetupAccount | null> }
  | { type: "repos"; answer: SetupAnswer<SetupRepo[]> }
  | { type: "query"; query: string }
  | { type: "mode"; mode: RepoMode }
  | { type: "pick"; repo: SetupRepo }
  | { type: "name"; name: string }
  | { type: "created"; answer: SetupAnswer<SetupRepo> }
  | { type: "address"; address: string }
  | { type: "checked"; check: SetupCheck }
  | { type: "goto"; step: WizardStep }
  | { type: "back" }
  | { type: "saved" };

export function initialWizard(opts: { tokenStored: boolean; remoteUrl?: string; proposedName: string }): WizardState {
  const remote = opts.remoteUrl ? withoutCredentials(opts.remoteUrl).trim() : "";
  const s: WizardState = {
    step: "provider",
    provider: null,
    web: "",
    pasted: "",
    token: "",
    tokenStored: opts.tokenStored,
    savedRemote: remote,
    account: null,
    repos: null,
    reposProblem: null,
    query: "",
    mode: "pick",
    picked: null,
    newName: opts.proposedName,
    address: "",
    check: null,
    busy: null,
    problem: null,
  };
  // Set up again: the saved address preselects provider and server.
  return remote ? wizardReducer(s, { type: "paste", text: remote }) : s;
}

/** The server the requests go to. */
export function serverOf(s: WizardState): GitServer {
  const provider = s.provider ?? "other";
  return { provider, web: normalizeWeb(s.web) ?? defaultWeb(provider) };
}

/** The pasted address, read with the chosen provider's rules. */
export const pastedOf = (s: WizardState) => (s.pasted.trim() ? parseAddress(s.pasted, s.provider) : null);

/** The address typed in the third step (else the pasted one), read with the provider's rules. */
export function addressOf(s: WizardState): ParsedAddress | null {
  const typed = s.address.trim() ? parseAddress(s.address, s.provider) : null;
  return typed ?? (s.address.trim() ? null : pastedOf(s));
}

/** Whether the address is on the server's host. */
function onServer(a: ParsedAddress, server: GitServer): boolean {
  try {
    return new URL(server.web).host === a.host;
  } catch {
    return false;
  }
}

/** `owner` without the path the server lives below (a GitLab at `https://firma.de/gitlab`). */
function ownerBelow(a: ParsedAddress, web: string): string | null {
  if (!a.owner) return null;
  const prefix = normalizeWeb(web);
  if (!prefix) return a.owner;
  const u = new URL(prefix);
  const below = u.pathname.replace(/^\/+|\/+$/g, "");
  if (!below || u.host !== a.host) return a.owner;
  return a.owner === below ? null : a.owner.startsWith(`${below}/`) ? a.owner.slice(below.length + 1) : a.owner;
}

/** The repository the check and the save use. */
export function targetOf(s: WizardState): SetupTarget | null {
  const provider = s.provider ?? "other";
  if (!hasApi(provider)) {
    // Another server: the address as typed (git knows its form), never an SSH address.
    const raw = withoutCredentials(s.address.trim() || s.pasted.trim()).replace(/\/+$/, "");
    const a = raw ? parseAddress(raw, "other") : null;
    if (!raw || a?.ssh) return null;
    const http = /^https?:\/\/[^/]+\/./i.test(raw);
    const local = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || /^file:\/\//i.test(raw);
    if (http || local) return { url: raw, owner: null, name: null };
    return a?.https ? { url: a.https, owner: null, name: null } : null;
  }
  if (s.mode === "pick") return s.picked ? { url: s.picked.clone_url, owner: s.picked.owner, name: s.picked.name } : null;
  if (s.mode !== "address") return null;
  const a = addressOf(s);
  if (!a?.https || a.ssh) return null;
  const owner = ownerBelow(a, serverOf(s).web);
  return owner && a.name ? { url: a.https, owner, name: a.name } : null;
}

/**
 * Whether the stored token may be used: only on the server of the saved repository (the
 * provider's address and the repository's), so a token made for one server never reaches
 * another. The shell checks the same (src-tauri/src/gitsetup.rs `pick_token`).
 */
export function storedTokenFits(s: WizardState): boolean {
  const home = serverKey(s.savedRemote);
  if (!s.tokenStored || !home) return false;
  const provider = s.provider ?? "other";
  if (hasApi(provider) && serverKey(serverOf(s).web) !== home) return false;
  const target = targetOf(s);
  return !target || serverKey(target.url) === home;
}

/** The hint under the token field: the stored token is used, belongs to another server (its
 *  host), or where a typed one goes. */
export function tokenNote(s: WizardState): { key: TKey; host: string; reuse: boolean } {
  const host = serverKey(s.savedRemote)?.replace(/^https?:\/\//, "") ?? "";
  if (storedTokenFits(s)) return { key: "gitsetup.token.storedNote", host, reuse: true };
  if (s.tokenStored && host) return { key: "gitsetup.token.storedOther", host, reuse: false };
  return { key: "gitsetup.token.safe", host, reuse: false };
}

/** A token must be typed: the provider has an API and the stored one does not fit. */
const tokenNeeded = (s: WizardState) => hasApi(s.provider ?? "other") && !s.token.trim() && !storedTokenFits(s);

/** Why the current step cannot go on (`null`: it can). */
export function blocker(s: WizardState): TKey | null {
  switch (s.step) {
    case "provider": {
      if (!s.provider) return "gitsetup.provider.choose";
      const pasted = pastedOf(s);
      if (s.pasted.trim() && !pasted) return "gitsetup.pasteInvalid";
      if (hasApi(s.provider) && s.web.trim() && !normalizeWeb(s.web)) return "gitsetup.serverInvalid";
      if (s.provider === "gitea" && !normalizeWeb(s.web)) return "gitsetup.serverNeeded";
      return null;
    }
    case "token":
      return tokenNeeded(s) ? "gitsetup.token.needed" : null;
    case "repo":
      if (s.mode === "create") return validRepoName(s.newName) ? null : "gitsetup.repo.nameInvalid";
      if (s.mode === "pick") return s.picked ? null : "gitsetup.repo.pickOne";
      if (addressOf(s)?.ssh) return "gitsetup.repo.sshFirst";
      if (!targetOf(s)) return "gitsetup.repo.addressNeeded";
      // A repository on another server than the stored token's: a token for it first.
      return tokenNeeded(s) ? "gitsetup.token.needed" : null;
    default:
      return null;
  }
}

export function wizardReducer(s: WizardState, a: WizardAction): WizardState {
  switch (a.type) {
    case "provider": {
      if (a.provider === s.provider) return s;
      // Another provider: its own server, list and account.
      const pasted = pastedOf({ ...s, provider: a.provider });
      const sameHost = pasted && (pasted.provider === a.provider || (!pasted.provider && a.provider !== "other"));
      return {
        ...s,
        provider: a.provider,
        web: sameHost && pasted.web !== defaultWeb(a.provider) ? pasted.web : "",
        account: null,
        repos: null,
        reposProblem: null,
        picked: null,
        check: null,
        problem: null,
        mode: a.provider === "other" ? "address" : s.mode,
      };
    }
    case "web":
      return { ...s, web: a.web, account: null, repos: null, picked: null, check: null, problem: null };
    case "paste": {
      const p = parseAddress(a.text, s.provider);
      const next: WizardState = { ...s, pasted: a.text, problem: null, check: null };
      if (!p) return next;
      // The address names its provider (github.com, gitlab.com …): chosen with it; an unknown host
      // keeps the chosen provider and becomes its server.
      const provider = p.provider ?? s.provider;
      const web = provider && p.web !== defaultWeb(provider) ? p.web : "";
      return {
        ...next,
        provider: provider ?? null,
        web: provider === "other" ? "" : web,
        address: p.owner ? a.text.trim() : s.address,
        mode: p.owner || provider === "other" ? "address" : s.mode,
      };
    }
    case "token":
      return { ...s, token: a.token, account: null, problem: null };
    case "busy":
      // A new request: the last one's problem goes (the answer brings its own).
      return { ...s, busy: a.busy, problem: a.busy ? null : s.problem };
    case "problem":
      return { ...s, problem: a.problem, busy: null };
    case "account":
      if (a.answer.problem) return { ...s, busy: null, problem: a.answer.problem };
      return { ...s, busy: null, problem: null, account: a.answer.value, step: "repo" };
    case "repos": {
      if (a.answer.problem) return { ...s, busy: null, repos: [], reposProblem: a.answer.problem, mode: s.mode === "pick" || !canCreate(s.provider ?? "other") ? "address" : s.mode };
      const repos = a.answer.value ?? [];
      // The pasted repository, when it is in the list, is picked.
      const named = addressOf(s);
      // The saved or pasted address: the repository of that name, or of that clone address.
      const bare = (u: string) => u.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
      const typed = bare(s.address || s.pasted);
      const hit =
        (named?.owner ? repos.find((r) => r.owner.toLowerCase() === named.owner?.toLowerCase() && r.name.toLowerCase() === named.name?.toLowerCase()) : undefined) ??
        (typed ? repos.find((r) => bare(r.clone_url) === typed) : undefined);
      return {
        ...s,
        busy: null,
        repos,
        reposProblem: null,
        picked: hit ?? s.picked,
        // An address on another server (the saved one of another provider) is not kept.
        mode: hit ? "pick" : s.mode === "address" && named?.owner && onServer(named, serverOf(s)) ? "address" : repos.length ? "pick" : canCreate(s.provider ?? "other") ? "create" : "address",
      };
    }
    case "query":
      return { ...s, query: a.query };
    case "mode":
      if (a.mode === "create" && !canCreate(s.provider ?? "other")) return s;
      return { ...s, mode: a.mode, problem: null };
    case "pick":
      return { ...s, picked: a.repo, mode: "pick", problem: null };
    case "name":
      return { ...s, newName: a.name, problem: null };
    case "created":
      if (a.answer.problem || !a.answer.value) return { ...s, busy: null, problem: a.answer.problem };
      return { ...s, busy: null, problem: null, picked: a.answer.value, mode: "pick", repos: [a.answer.value, ...(s.repos ?? [])], step: "check", check: null };
    case "address":
      return { ...s, address: a.address, problem: null };
    case "checked":
      return { ...s, busy: null, check: a.check, problem: a.check.problem };
    case "goto":
      return { ...s, step: a.step, problem: null, check: a.step === "check" ? null : s.check };
    case "back": {
      const i = WIZARD_STEPS.indexOf(s.step);
      return i > 0 ? { ...s, step: WIZARD_STEPS[i - 1], problem: null, busy: null, check: null } : s;
    }
    case "saved":
      return { ...s, busy: null, step: "done", problem: null };
  }
}

/** The settings the setup saves: the repository's address, the branch, switched on. */
export function savedGit(check: SetupCheck, target: SetupTarget): { remote_url: string; branch: string; enabled: true } {
  return { remote_url: target.url, branch: check.branch ?? "main", enabled: true };
}

/** The repository's name for the texts. */
export function targetName(s: WizardState): string {
  const t = targetOf(s);
  if (!t) return "";
  return t.owner && t.name ? `${t.owner}/${t.name}` : t.url;
}
