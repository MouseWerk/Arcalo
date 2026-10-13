import { describe, expect, it } from "vitest";
import {
  blocker,
  canCreate,
  contentKey,
  storedTokenFits,
  withoutCredentials,
  filterRepos,
  initialWizard,
  normalizeWeb,
  parseAddress,
  problemKeys,
  savedGit,
  serverOf,
  stepKey,
  targetOf,
  tokenPage,
  validRepoName,
  wizardReducer,
  type SetupCheck,
  type SetupRepo,
  type WizardAction,
  type WizardState,
} from "./gitsetup";
import { en } from "../locales/en";
import { de } from "../locales/de";

const repo = (owner: string, name: string, extra: Partial<SetupRepo> = {}): SetupRepo => ({
  owner,
  name,
  full_name: `${owner}/${name}`,
  private: true,
  clone_url: `https://github.com/${owner}/${name}.git`,
  web_url: `https://github.com/${owner}/${name}`,
  default_branch: "main",
  empty: null,
  can_push: true,
  updated: null,
  description: null,
  ...extra,
});

const run = (s: WizardState, ...actions: WizardAction[]) => actions.reduce(wizardReducer, s);
const fresh = (tokenStored = false, remoteUrl?: string) => initialWizard({ tokenStored, remoteUrl, proposedName: "arcalo-notizen" });

describe("parseAddress", () => {
  const p = (raw: string, hint: Parameters<typeof parseAddress>[1] = null) => {
    const r = parseAddress(raw, hint);
    return r && { provider: r.provider, web: r.web, owner: r.owner, name: r.name, https: r.https, ssh: r.ssh };
  };

  it("reads what people paste from GitHub", () => {
    const want = { provider: "github", web: "https://github.com", owner: "mia", name: "notizen", https: "https://github.com/mia/notizen.git", ssh: false };
    for (const raw of [
      "https://github.com/mia/notizen",
      "https://github.com/mia/notizen.git",
      "https://github.com/mia/notizen/",
      "https://github.com/mia/notizen.git/",
      "  https://www.github.com/mia/notizen  ".replace("www.", ""),
      "github.com/mia/notizen",
      "https://github.com/mia/notizen/tree/main/Projekte",
      "https://github.com/mia/notizen/blob/main/README.md",
      "https://github.com/mia/notizen?tab=readme-ov-file",
      "https://github.com/mia/notizen#readme",
      "https://bob:secret@github.com/mia/notizen.git",
    ]) {
      expect(p(raw), raw).toEqual(want);
    }
  });

  it("offers the HTTPS address for an SSH address", () => {
    expect(p("git@github.com:mia/notizen.git")).toEqual({ provider: "github", web: "https://github.com", owner: "mia", name: "notizen", https: "https://github.com/mia/notizen.git", ssh: true });
    expect(p("ssh://git@git.firma.de:2222/team/notizen.git")).toMatchObject({ web: "https://git.firma.de", owner: "team", name: "notizen", https: "https://git.firma.de/team/notizen.git", ssh: true });
    expect(p("git@gitlab.com:gruppe/unter/notizen.git")).toMatchObject({ provider: "gitlab", owner: "gruppe/unter", name: "notizen", ssh: true });
    expect(p("mia@codeberg.org:mia/notizen")).toMatchObject({ provider: "gitea", ssh: true, https: "https://codeberg.org/mia/notizen.git" });
  });

  it("knows the path rules of GitLab, Gitea and Bitbucket", () => {
    expect(p("https://gitlab.com/gruppe/unter/notizen/-/tree/main")).toMatchObject({ provider: "gitlab", owner: "gruppe/unter", name: "notizen" });
    expect(p("https://gitlab.com/gruppe/unter/notizen.git")).toMatchObject({ owner: "gruppe/unter", name: "notizen", https: "https://gitlab.com/gruppe/unter/notizen.git" });
    // A company's GitLab says nothing in its name: the chosen provider decides.
    expect(p("https://code.firma.de/team/projekte/notizen", "gitlab")).toMatchObject({ provider: null, owner: "team/projekte", name: "notizen" });
    expect(p("https://code.firma.de/team/projekte/notizen", "gitea")).toMatchObject({ owner: "team", name: "projekte" });
    expect(p("https://codeberg.org/mia/notizen/src/branch/main/Tagebuch")).toMatchObject({ provider: "gitea", owner: "mia", name: "notizen" });
    expect(p("https://git.example.org/mia/notizen/issues/3")).toMatchObject({ owner: "mia", name: "notizen" });
    expect(p("https://mia@bitbucket.org/team/notizen.git")).toMatchObject({ provider: "bitbucket", owner: "team", name: "notizen", https: "https://bitbucket.org/team/notizen.git" });
    expect(p("https://bitbucket.org/team/notizen/src/main/")).toMatchObject({ owner: "team", name: "notizen" });
  });

  it("takes self-hosted servers, ports and http as pasted", () => {
    expect(p("http://127.0.0.1:3000/mia/notizen")).toMatchObject({ provider: null, web: "http://127.0.0.1:3000", https: "http://127.0.0.1:3000/mia/notizen.git", ssh: false });
    expect(p("https://gitea.firma.de")).toMatchObject({ provider: "gitea", web: "https://gitea.firma.de", owner: null, name: null, https: null });
    expect(p("localhost:3000/mia/notizen")).toMatchObject({ web: "https://localhost:3000", owner: "mia", ssh: false });
  });

  it("refuses what is no address", () => {
    for (const raw of ["", "   ", "notizen", "ftp://x.de/a/b", "mein repo", "C:\\Notizen\\repo"]) {
      expect(parseAddress(raw), raw).toBeNull();
    }
  });

  it("normalizes web addresses", () => {
    expect(normalizeWeb("gitlab.firma.de/")).toBe("https://gitlab.firma.de");
    expect(normalizeWeb("https://firma.de/gitlab/")).toBe("https://firma.de/gitlab");
    expect(normalizeWeb("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeWeb("ssh://x")).toBeNull();
    expect(normalizeWeb("")).toBeNull();
  });
});

describe("token pages", () => {
  it("preselect the scopes where the provider takes them", () => {
    expect(tokenPage("github", "")).toBe("https://github.com/settings/tokens/new?scopes=repo&description=Arcalo");
    expect(tokenPage("github", "https://ghe.firma.de/")).toBe("https://ghe.firma.de/settings/tokens/new?scopes=repo&description=Arcalo");
    expect(tokenPage("gitlab", "")).toBe("https://gitlab.com/-/user_settings/personal_access_tokens?name=Arcalo&scopes=read_repository,write_repository,read_api");
    expect(tokenPage("gitea", "https://codeberg.org")).toBe("https://codeberg.org/user/settings/applications");
    expect(tokenPage("gitea", "")).toBeNull();
    expect(tokenPage("bitbucket", "", { owner: "team", name: "notizen" })).toBe("https://bitbucket.org/team/notizen/admin/access-tokens");
    expect(tokenPage("bitbucket", "")).toBe("https://bitbucket.org/account/workspaces/");
    expect(tokenPage("other", "https://git.firma.de")).toBeNull();
  });
});

describe("names and lists", () => {
  it("accepts the names every provider takes", () => {
    expect(validRepoName("arcalo-notizen")).toBe(true);
    expect(validRepoName("Notes_2026.v2")).toBe(true);
    for (const bad of ["", " ", ".x", "-x", "a b", "x.git", "ä", "a/b", "x".repeat(101)]) expect(validRepoName(bad), bad).toBe(false);
  });

  it("filters by every word, in the server's order", () => {
    const list = [repo("mia", "notizen", { description: "Mein Arbeitsbereich" }), repo("team", "website"), repo("mia", "rezepte")];
    expect(filterRepos(list, "").length).toBe(3);
    expect(filterRepos(list, "MIA").map((r) => r.name)).toEqual(["notizen", "rezepte"]);
    expect(filterRepos(list, "mia arbeits").map((r) => r.name)).toEqual(["notizen"]);
    expect(filterRepos(list, "nichts")).toEqual([]);
  });
});

describe("the wizard", () => {
  it("goes provider, token, repository with a pick from the list", () => {
    let s = fresh();
    expect(blocker(s)).toBe("gitsetup.provider.choose");
    s = run(s, { type: "provider", provider: "github" });
    expect(blocker(s)).toBeNull();
    expect(serverOf(s)).toEqual({ provider: "github", web: "https://github.com" });
    s = run(s, { type: "goto", step: "token" });
    expect(blocker(s)).toBe("gitsetup.token.needed");
    s = run(s, { type: "token", token: "ghp_x" });
    expect(blocker(s)).toBeNull();
    s = run(s, { type: "account", answer: { value: { login: "mia", name: null, expires: null, scopes: ["repo"] }, problem: null } });
    expect(s.step).toBe("repo");
    s = run(s, { type: "repos", answer: { value: [repo("mia", "a"), repo("mia", "b")], problem: null } });
    expect(s.mode).toBe("pick");
    expect(blocker(s)).toBe("gitsetup.repo.pickOne");
    s = run(s, { type: "pick", repo: s.repos![1] });
    expect(targetOf(s)).toEqual({ url: "https://github.com/mia/b.git", owner: "mia", name: "b" });
    s = run(s, { type: "goto", step: "check" });
    expect(s.step).toBe("check");
    s = run(s, { type: "back" }, { type: "back" });
    expect(s.step).toBe("token");
  });

  it("a stored token is enough to go on on the server of the saved repository", () => {
    const s = run(fresh(true, "https://gitlab.com/g/notizen.git"), { type: "provider", provider: "gitlab" }, { type: "goto", step: "token" });
    expect(blocker(s)).toBeNull();
  });

  it("the stored token (for github.com) is not sent to another server without a new token", () => {
    let s = initialWizard({ tokenStored: true, remoteUrl: "https://github.com/mia/notizen.git", proposedName: "arcalo-notizen" });
    s = wizardReducer(s, { type: "provider", provider: "gitea" });
    s = wizardReducer(s, { type: "web", web: "https://git.example.org" });
    s = wizardReducer(s, { type: "goto", step: "token" });
    expect(serverOf(s).web).toBe("https://git.example.org");
    expect(blocker(s)).toBe("gitsetup.token.needed");
    expect(storedTokenFits(s)).toBe(false);
    s = wizardReducer(s, { type: "token", token: "gitea-neu" });
    expect(blocker(s)).toBeNull();
  });

  it("the stored token stays home: no saved address, another port, or a repository on another host", () => {
    // A token without a saved repository belongs to no known server.
    expect(blocker(run(fresh(true), { type: "provider", provider: "github" }, { type: "goto", step: "token" }))).toBe("gitsetup.token.needed");
    // The same host on another port is another server.
    let s = run(fresh(true, "https://git.firma.de/team/notizen.git"), { type: "provider", provider: "gitea" }, { type: "web", web: "https://git.firma.de:8443" }, { type: "goto", step: "token" });
    expect(blocker(s)).toBe("gitsetup.token.needed");
    // The saved server, but the repository typed on another host.
    s = run(fresh(true, "https://github.com/mia/notizen.git"), { type: "goto", step: "token" });
    expect(blocker(s)).toBeNull();
    s = run(s, { type: "goto", step: "repo" }, { type: "mode", mode: "address" }, { type: "address", address: "https://git.example.org/mia/notizen" });
    expect(blocker(s)).toBe("gitsetup.token.needed");
    // Another server without sign-in needs no token at all.
    s = run(fresh(true, "https://github.com/mia/notizen.git"), { type: "provider", provider: "other" }, { type: "goto", step: "repo" }, { type: "address", address: "https://git.example.org/notizen.git" });
    expect(blocker(s)).toBeNull();
    expect(storedTokenFits(s)).toBe(false);
  });

  it("a saved address with a user name and password shows and stores neither", () => {
    let s = fresh(true, "https://mia:ghp_geheim@github.com/mia/notizen.git");
    expect(s.provider).toBe("github");
    expect(JSON.stringify(s)).not.toContain("ghp_geheim");
    expect(JSON.stringify(s)).not.toContain("mia:");
    expect(targetOf(s)).toEqual({ url: "https://github.com/mia/notizen.git", owner: "mia", name: "notizen" });
    // Another server: the address as typed, without what it says about the sign-in.
    s = fresh(true, "https://bob:pw@git.firma.de/notizen.git");
    s = run(s, { type: "provider", provider: "other" });
    expect(JSON.stringify(s)).not.toContain("bob:pw");
    s = run(s, { type: "address", address: "https://bob:pw@git.firma.de/notizen.git" });
    expect(targetOf(s)).toEqual({ url: "https://git.firma.de/notizen.git", owner: null, name: null });
    expect(withoutCredentials("https://x-token-auth:t@bitbucket.org/team/n.git")).toBe("https://bitbucket.org/team/n.git");
    expect(withoutCredentials("git@github.com:mia/n.git")).toBe("git@github.com:mia/n.git");
    expect(withoutCredentials("/srv/git/n.git")).toBe("/srv/git/n.git");
  });

  it("Bitbucket's access tokens cannot create a repository: an address or the list instead", () => {
    expect(canCreate("bitbucket")).toBe(false);
    expect(canCreate("github")).toBe(true);
    let s = run(fresh(), { type: "provider", provider: "bitbucket" }, { type: "goto", step: "repo" }, { type: "repos", answer: { value: [], problem: null } });
    expect(s.mode).toBe("address");
    s = run(s, { type: "mode", mode: "create" });
    expect(s.mode).toBe("address");
  });

  it("a pasted repository chooses the provider and is picked once the list has it", () => {
    let s = run(fresh(), { type: "paste", text: "git@github.com:mia/notizen.git" });
    expect(s.provider).toBe("github");
    expect(s.web).toBe("");
    expect(s.mode).toBe("address");
    s = run(s, { type: "paste", text: "https://github.com/mia/notizen.git" });
    s = run(s, { type: "goto", step: "token" }, { type: "token", token: "t" }, { type: "account", answer: { value: { login: "mia", name: null, expires: null, scopes: null }, problem: null } });
    s = run(s, { type: "repos", answer: { value: [repo("mia", "andere"), repo("Mia", "Notizen")], problem: null } });
    expect(s.mode).toBe("pick");
    expect(s.picked?.full_name).toBe("Mia/Notizen");
  });

  it("an unknown host becomes the chosen provider's server", () => {
    let s = run(fresh(), { type: "provider", provider: "gitea" });
    expect(blocker(s)).toBe("gitsetup.serverNeeded");
    s = run(s, { type: "paste", text: "https://git.firma.de/team/notizen" });
    expect(s.provider).toBe("gitea");
    expect(serverOf(s)).toEqual({ provider: "gitea", web: "https://git.firma.de" });
    expect(blocker(s)).toBeNull();
    s = run(s, { type: "web", web: "kein server" });
    expect(blocker(s)).toBe("gitsetup.serverInvalid");
  });

  it("an SSH address in the repository step waits for the HTTPS one", () => {
    let s = run(fresh(), { type: "provider", provider: "gitlab" }, { type: "goto", step: "repo" }, { type: "mode", mode: "address" }, { type: "address", address: "git@gitlab.com:g/x.git" });
    expect(blocker(s)).toBe("gitsetup.repo.sshFirst");
    expect(targetOf(s)).toBeNull();
    s = run(s, { type: "address", address: "https://gitlab.com/g/x" });
    expect(targetOf(s)).toEqual({ url: "https://gitlab.com/g/x.git", owner: "g", name: "x" });
  });

  it("a GitLab below a path of its server takes owner and name without that path", () => {
    const s = run(fresh(), { type: "provider", provider: "gitlab" }, { type: "web", web: "https://firma.de/gitlab" }, { type: "goto", step: "repo" }, { type: "mode", mode: "address" }, { type: "address", address: "https://firma.de/gitlab/team/notizen" });
    expect(targetOf(s)).toEqual({ url: "https://firma.de/gitlab/team/notizen.git", owner: "team", name: "notizen" });
  });

  it("a list that cannot be loaded leaves the address field", () => {
    const s = run(fresh(), { type: "provider", provider: "bitbucket" }, { type: "goto", step: "repo" }, { type: "repos", answer: { value: null, problem: { kind: "token_scope", status: 403, detail: "" } } });
    expect(s.mode).toBe("address");
    expect(s.reposProblem?.kind).toBe("token_scope");
  });

  it("creating needs a valid name and goes on to the check", () => {
    let s = run(fresh(), { type: "provider", provider: "github" }, { type: "goto", step: "repo" }, { type: "repos", answer: { value: [], problem: null } });
    expect(s.mode).toBe("create");
    expect(s.newName).toBe("arcalo-notizen");
    expect(blocker(s)).toBeNull();
    s = run(s, { type: "name", name: "mein repo" });
    expect(blocker(s)).toBe("gitsetup.repo.nameInvalid");
    s = run(s, { type: "name", name: "arcalo-notizen" }, { type: "created", answer: { value: null, problem: { kind: "exists", status: 422, detail: "" } } });
    expect(s.step).toBe("repo");
    expect(s.problem?.kind).toBe("exists");
    s = run(s, { type: "created", answer: { value: repo("mia", "arcalo-notizen", { empty: true }), problem: null } });
    expect(s.step).toBe("check");
    expect(targetOf(s)?.name).toBe("arcalo-notizen");
  });

  it("another server takes the address as typed", () => {
    let s = run(fresh(), { type: "provider", provider: "other" }, { type: "goto", step: "token" });
    expect(blocker(s)).toBeNull();
    s = run(s, { type: "goto", step: "repo" });
    expect(s.mode).toBe("address");
    expect(blocker(s)).toBe("gitsetup.repo.addressNeeded");
    s = run(s, { type: "address", address: "https://git.firma.de/notizen.git/" });
    expect(targetOf(s)).toEqual({ url: "https://git.firma.de/notizen.git", owner: null, name: null });
    s = run(s, { type: "address", address: "/srv/git/notizen.git" });
    expect(targetOf(s)?.url).toBe("/srv/git/notizen.git");
    s = run(s, { type: "address", address: "git@git.firma.de:notizen.git" });
    expect(targetOf(s)).toBeNull();
  });

  it("setting up again starts from the saved address", () => {
    const s = fresh(true, "https://gitlab.com/g/notizen.git");
    expect(s.provider).toBe("gitlab");
    expect(s.mode).toBe("address");
    expect(targetOf(s)).toEqual({ url: "https://gitlab.com/g/notizen.git", owner: "g", name: "notizen" });
  });

  it("setting up again picks the saved repository by its clone address", () => {
    let s = fresh(true, "http://127.0.0.1:4000/git/mia/notizen.git");
    expect(s.provider).toBeNull();
    s = run(s, { type: "provider", provider: "github" });
    expect(serverOf(s)).toEqual({ provider: "github", web: "http://127.0.0.1:4000" });
    const saved = repo("mia", "notizen", { clone_url: "http://127.0.0.1:4000/git/mia/notizen.git" });
    s = run(s, { type: "repos", answer: { value: [repo("mia", "x"), saved], problem: null } });
    expect(s.mode).toBe("pick");
    expect(s.picked).toEqual(saved);
  });

  it("a saved address on another server is not kept for this one", () => {
    let s = fresh(true, "https://gitlab.com/g/notizen.git");
    s = run(s, { type: "provider", provider: "gitea" }, { type: "web", web: "https://codeberg.org" });
    s = run(s, { type: "repos", answer: { value: [repo("mia", "a")], problem: null } });
    expect(s.mode).toBe("pick");
    expect(s.picked).toBeNull();
  });

  it("a new request clears the last problem", () => {
    let s = run(fresh(), { type: "problem", problem: { kind: "proxy", status: null, detail: "" } });
    expect(s.problem?.kind).toBe("proxy");
    s = run(s, { type: "busy", busy: "account" });
    expect(s.problem).toBeNull();
  });

  it("another provider forgets the account, the list and the pick", () => {
    let s = run(fresh(), { type: "provider", provider: "github" }, { type: "account", answer: { value: { login: "mia", name: null, expires: null, scopes: null }, problem: null } }, { type: "repos", answer: { value: [repo("mia", "a")], problem: null } }, { type: "pick", repo: repo("mia", "a") });
    s = run(s, { type: "provider", provider: "gitea" });
    expect([s.account, s.repos, s.picked]).toEqual([null, null, null]);
  });

  it("saves the address, the checked branch and switches the sync on", () => {
    const check: SetupCheck = { steps: [], problem: null, account: null, branch: "arcalo", default_branch: "main", branches: ["main"], content: "other", write: true };
    expect(savedGit(check, { url: "https://github.com/mia/x.git", owner: "mia", name: "x" })).toEqual({ remote_url: "https://github.com/mia/x.git", branch: "arcalo", enabled: true });
    expect(contentKey(check)).toBe("gitsetup.content.other");
    expect(contentKey({ ...check, branch: "main" })).toBe("gitsetup.content.otherFallback");
    expect(contentKey({ ...check, content: "arcalo" })).toBe("gitsetup.content.arcalo");
    expect(contentKey({ ...check, content: "empty" })).toBe("gitsetup.content.empty");
    expect(contentKey({ ...check, content: null })).toBeNull();
  });
});

describe("wording", () => {
  const kinds = ["token_missing", "token_invalid", "token_expired", "token_scope", "no_write", "not_found", "exists", "bad_name", "bad_address", "rate_limited", "proxy", "certificate", "unreachable", "timeout", "ssh", "git_missing", "not_api", "server", "other"] as const;
  it("every problem has its words and its fix in both languages", () => {
    for (const k of kinds) {
      const { title, fix } = problemKeys(k);
      for (const cat of [en, de] as Record<string, unknown>[]) {
        expect(cat[title], title).toBeTruthy();
        expect(cat[fix], fix).toBeTruthy();
      }
    }
  });
  it("every step of the check has a label", () => {
    for (const id of ["server", "token", "repository", "write", "git", "branch"] as const) {
      for (const state of ["ok", "fail", "unknown", "skipped"] as const) {
        for (const provider of ["github", "other"] as const) expect(en[stepKey(id, state, provider) as keyof typeof en], `${id} ${state}`).toBeTruthy();
      }
    }
  });
});
