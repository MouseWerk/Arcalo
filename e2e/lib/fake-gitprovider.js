// A fake Git provider for the guided setup's end-to-end tests: the REST API of GitHub (as GitHub
// Enterprise answers it, below /api/v3), GitLab (/api/v4) or Gitea (/api/v1), and a Git server
// over HTTP for its repositories (`git http-backend` below /git, HTTP Basic with the token as the
// password, as the providers take it). All on 127.0.0.1; every request is recorded. Never the
// real internet.
//
// Knobs on `state`: `token` (the API's), `gitToken` (git's, default the same), `scopes` (GitHub's
// X-OAuth-Scopes; null for a fine-grained token), `gitlabScopes`, `expired` (GitLab says the token
// expired), `fail = { status, body, times }` (the next API answers), `html` (a sign-in page instead
// of the API), `delay` (ms before each API answer).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const API = { github: "/api/v3", gitlab: "/api/v4", gitea: "/api/v1" };
const MARKER = "# Arcalo Git-Synchronisierung\n* text=auto\n";

const sh = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

export async function startFakeProvider({ flavor = "github", token = "ghp_e2eSetupToken4711", owner = "mia" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `arcalo-e2e-${flavor}-`));
  const seen = [];
  const repos = [];
  const state = { token, gitToken: null, scopes: "repo, read:org", gitlabScopes: ["read_repository", "write_repository", "read_api", "api"], expired: false, fail: null, html: false, delay: 0, base: "" };

  const barePath = (o, n) => path.join(root, ...o.split("/"), `${n}.git`);
  /** A repository: `push` false = read only for the account; `files` = a first commit on main. */
  function addRepo(name, { push = true, files = null, repoOwner = owner, description = null, privateRepo = true } = {}) {
    const bare = barePath(repoOwner, name);
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    sh(["init", "-q", "--bare", "-b", "main", bare]);
    sh(["config", "http.receivepack", "true"], { cwd: bare });
    if (files) {
      const work = fs.mkdtempSync(path.join(root, "work-"));
      sh(["init", "-q", "-b", "main"], { cwd: work });
      for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(work, f), text);
      sh(["add", "-A"], { cwd: work });
      sh(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "first"], { cwd: work });
      sh(["push", "-q", bare, "main"], { cwd: work });
      fs.rmSync(work, { recursive: true, force: true });
    }
    const r = { owner: repoOwner, name, push, bare, description, private: privateRepo, updated: new Date(Date.now() - repos.length * 60_000).toISOString() };
    repos.push(r);
    return r;
  }
  const find = (o, n) => repos.find((r) => r.owner.toLowerCase() === o.toLowerCase() && r.name.toLowerCase() === n.toLowerCase());
  const cloneUrl = (r) => `${state.base}/git/${r.owner}/${r.name}.git`;
  const branches = (r) => sh(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: r.bare }).split("\n").filter(Boolean);
  const attributes = (r, ref) => {
    try {
      return sh(["show", `${ref}:.gitattributes`], { cwd: r.bare });
    } catch {
      return null;
    }
  };
  /** The commits on a branch of a repository (newest first), for the tests. */
  const log = (r, branch = "main") => {
    try {
      return sh(["log", "--format=%s", branch], { cwd: r.bare }).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const files = (r, branch = "main") => {
    try {
      return sh(["ls-tree", "-r", "--name-only", branch], { cwd: r.bare }).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const githubRepo = (r) => ({
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner },
    private: r.private,
    clone_url: cloneUrl(r),
    html_url: `${state.base}/${r.owner}/${r.name}`,
    default_branch: "main",
    description: r.description,
    permissions: { admin: r.push, push: r.push, pull: true },
    pushed_at: r.updated,
  });
  const giteaRepo = (r) => ({ ...githubRepo(r), empty: branches(r).length === 0, updated_at: r.updated });
  const gitlabProject = (r) => ({
    path_with_namespace: `${r.owner}/${r.name}`,
    path: r.name,
    visibility: r.private ? "private" : "public",
    http_url_to_repo: cloneUrl(r),
    web_url: `${state.base}/${r.owner}/${r.name}`,
    default_branch: branches(r).length ? "main" : null,
    empty_repo: branches(r).length === 0,
    description: r.description,
    last_activity_at: r.updated,
    permissions: { project_access: { access_level: r.push ? 40 : 20 }, group_access: null },
  });

  function authorized(req) {
    const a = req.headers.authorization ?? "";
    return flavor === "gitea" ? a === `token ${state.token}` : a === `Bearer ${state.token}`;
  }

  function api(req, res, p, url, body) {
    if (state.html) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html><body>Anmelden</body></html>");
    }
    if (state.fail && state.fail.times > 0) {
      state.fail.times--;
      return json(res, state.fail.status, state.fail.body ?? { message: `HTTP ${state.fail.status}` }, state.fail.headers ?? {});
    }
    if (!authorized(req)) return json(res, 401, flavor === "github" ? { message: "Bad credentials" } : { message: "401 Unauthorized" });
    if (state.expired) return json(res, 401, { error: "invalid_token", error_description: "Token is expired. You can either do re-authorization or token refresh." });
    const q = (k) => url.searchParams.get(k);
    const seg = p.split("/").filter(Boolean).map(decodeURIComponent);
    const mine = repos;
    if (flavor === "github") {
      const scoped = state.scopes == null ? {} : { "x-oauth-scopes": state.scopes };
      if (req.method === "GET" && p === "/user") return json(res, 200, { login: owner, name: "Mia Meyer" }, { ...scoped, "github-authentication-token-expiration": "2027-01-31 10:00:00 UTC" });
      if (req.method === "GET" && p === "/user/repos") {
        const per = Number(q("per_page") ?? 30);
        const page = Number(q("page") ?? 1);
        return json(res, 200, mine.slice((page - 1) * per, page * per).map(githubRepo));
      }
      if (req.method === "POST" && p === "/user/repos") {
        if (find(owner, body.name)) return json(res, 422, { message: "Repository creation failed.", errors: [{ resource: "Repository", field: "name", message: "name already exists on this account" }] });
        return json(res, 201, githubRepo(addRepo(body.name)));
      }
      if (req.method === "GET" && seg[0] === "repos" && seg.length === 3) {
        const r = find(seg[1], seg[2]);
        return r ? json(res, 200, githubRepo(r), scoped) : json(res, 404, { message: "Not Found" });
      }
      if (req.method === "GET" && seg[0] === "repos" && seg[3] === "contents" && seg[4] === ".gitattributes") {
        const r = find(seg[1], seg[2]);
        const text = r && attributes(r, q("ref") ?? "main");
        return text != null ? json(res, 200, { encoding: "base64", content: Buffer.from(text).toString("base64") }) : json(res, 404, { message: "Not Found" });
      }
    }
    if (flavor === "gitlab") {
      if (req.method === "GET" && p === "/user") return json(res, 200, { username: owner, name: "Mia Meyer" });
      if (req.method === "GET" && p === "/personal_access_tokens/self") return json(res, 200, { scopes: state.gitlabScopes, expires_at: "2027-01-31" });
      if (req.method === "GET" && p === "/projects") {
        const page = Number(q("page") ?? 1);
        const per = Number(q("per_page") ?? 20);
        const next = page * per < mine.length ? String(page + 1) : "";
        return json(res, 200, mine.slice((page - 1) * per, page * per).map(gitlabProject), { "x-next-page": next });
      }
      if (req.method === "POST" && p === "/projects") {
        if (!state.gitlabScopes.includes("api")) return json(res, 403, { error: "insufficient_scope", error_description: "The request requires higher privileges than provided by the access token.", scope: "api" });
        if (find(owner, body.path ?? body.name)) return json(res, 400, { message: { name: ["has already been taken"], path: ["has already been taken"] } });
        return json(res, 201, gitlabProject(addRepo(body.path ?? body.name)));
      }
      if (req.method === "GET" && seg[0] === "projects") {
        const id = seg[1];
        const slash = id.lastIndexOf("/");
        const r = slash > 0 ? find(id.slice(0, slash), id.slice(slash + 1)) : null;
        if (!r) return json(res, 404, { message: "404 Project Not Found" });
        if (seg[2] === "repository" && seg[4] === ".gitattributes") {
          const text = attributes(r, q("ref") ?? "main");
          if (text == null) return json(res, 404, { message: "404 File Not Found" });
          res.writeHead(200, { "content-type": "text/plain" });
          return res.end(text);
        }
        return json(res, 200, gitlabProject(r));
      }
    }
    if (flavor === "gitea") {
      if (req.method === "GET" && p === "/user") return json(res, 200, { login: owner, full_name: "Mia Meyer" });
      if (req.method === "GET" && p === "/user/repos") {
        const per = Number(q("limit") ?? 30);
        const page = Number(q("page") ?? 1);
        return json(res, 200, mine.slice((page - 1) * per, page * per).map(giteaRepo));
      }
      if (req.method === "POST" && p === "/user/repos") {
        if (find(owner, body.name)) return json(res, 409, { message: "The repository with the same name already exists." });
        return json(res, 201, giteaRepo(addRepo(body.name)));
      }
      if (req.method === "GET" && seg[0] === "repos") {
        const r = find(seg[1], seg[2]);
        if (!r) return json(res, 404, { message: "The target couldn't be found." });
        if (seg[3] === "raw" && seg[4] === ".gitattributes") {
          const text = attributes(r, q("ref") ?? "main");
          if (text == null) return json(res, 404, { message: "The target couldn't be found." });
          res.writeHead(200, { "content-type": "text/plain" });
          return res.end(text);
        }
        return json(res, 200, giteaRepo(r));
      }
    }
    return json(res, 404, { message: "Not Found" });
  }

  /** `git http-backend` for one request below /git, with the token as the Basic password. */
  function gitBackend(req, res, url, body) {
    const want = state.gitToken ?? state.token;
    const basic = (req.headers.authorization ?? "").replace(/^Basic /, "");
    const pw = Buffer.from(basic, "base64").toString("utf8").split(":").slice(1).join(":");
    if (pw !== want) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="git"' });
      return res.end();
    }
    const info = url.pathname.slice("/git".length);
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method,
        PATH_INFO: info,
        QUERY_STRING: url.search.replace(/^\?/, ""),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
        REMOTE_USER: "mia",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    const out = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stdin.end(body);
    child.on("close", () => {
      const raw = Buffer.concat(out);
      let at = raw.indexOf("\r\n\r\n");
      let len = 4;
      if (at < 0) [at, len] = [raw.indexOf("\n\n"), 2];
      if (at < 0) {
        res.writeHead(500);
        return res.end();
      }
      let status = 200;
      const headers = {};
      for (const line of raw.subarray(0, at).toString().split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]) || 500;
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.end(raw.subarray(at + len));
    });
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, "http://x");
      seen.push({ method: req.method, path: url.pathname, query: url.search, authorization: req.headers.authorization ?? null, userAgent: req.headers["user-agent"] ?? "" });
      if (url.pathname.startsWith("/git/")) return gitBackend(req, res, url, raw);
      const prefix = API[flavor];
      if (!url.pathname.startsWith(prefix)) return json(res, 404, { message: "Not Found" });
      if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
      let body = {};
      try {
        body = raw.length ? JSON.parse(raw.toString()) : {};
      } catch {
        /* not JSON */
      }
      api(req, res, url.pathname.slice(prefix.length) || "/", url, body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  state.base = `http://127.0.0.1:${port}`;
  return {
    flavor,
    base: state.base,
    port,
    root,
    state,
    seen,
    repos,
    addRepo,
    find,
    log,
    files,
    branches,
    cloneUrl,
    MARKER,
    close: () =>
      new Promise((r) =>
        server.close(() => {
          fs.rmSync(root, { recursive: true, force: true });
          r();
        }),
      ),
  };
}

/** A forward proxy that wants a sign-in it never gets (407 for every request). */
export async function startRefusingProxy() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(407, { "proxy-authenticate": 'Basic realm="firma"', "content-type": "text/html" });
    res.end("<html>Proxy Authentication Required</html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { seen, port, address: `127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
