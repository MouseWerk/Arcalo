//! The guided setup of the Git sync, on the desktop and the phone: whom a token belongs to, the
//! repositories to pick from, a new private one, and the check before saving
//! (`arcalo_core::gitsetup`). The requests take the Git sync's network route; the token is the one
//! typed into the setup (not saved yet) or the stored one, which only goes to the server of the
//! saved repository and never leaves the credential store otherwise. Saving is the UI's: the
//! settings and `git_token_set`, as with the form.

use std::time::Duration;

use arcalo_core::gitsetup::{self, Account, Api, Check, Problem, ProblemKind, Repo, Server, Target};
use arcalo_core::network::Service;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{AppState, Result, devlog};

/// What a setup request returns: its value or why not, in kinds the UI words.
#[derive(Serialize)]
pub struct Answer<T> {
    value: Option<T>,
    problem: Option<Problem>,
}

impl<T> From<std::result::Result<T, Problem>> for Answer<T> {
    fn from(r: std::result::Result<T, Problem>) -> Self {
        match r {
            Ok(v) => Answer { value: Some(v), problem: None },
            Err(p) => Answer { value: None, problem: Some(p) },
        }
    }
}

/// The typed token, else the stored one when every address the request goes to (`urls`: the
/// provider's web address, the repository) is on the server of the saved repository: a token made
/// for one server is never sent to another (the setup asks for a new one there).
fn pick_token(
    typed: Option<String>,
    stored: impl FnOnce() -> Option<String>,
    saved_remote: &str,
    urls: &[&str],
) -> Option<String> {
    if let Some(t) = typed.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
        return Some(t);
    }
    let own = !urls.is_empty() && urls.iter().all(|u| gitsetup::same_host(u, saved_remote));
    if own { stored() } else { None }
}

fn token_of(state: &AppState, token: Option<String>, urls: &[&str]) -> Option<String> {
    let saved = state.settings().git_sync.remote_url;
    let t = pick_token(token, || state.git_secret.get(), &saved, urls);
    devlog::remember_secret(t.as_deref());
    t
}

/// The total time of one API request: the Git sync profile's timeout, 10 to 60 s.
fn timeout(state: &AppState) -> Duration {
    crate::network::timeout_for(state, &Service::GitSync).clamp(Duration::from_secs(10), Duration::from_secs(60))
}

fn client(state: &AppState) -> std::result::Result<reqwest::Client, Problem> {
    crate::network::client_for(state, &Service::GitSync)
        .map_err(|e| Problem::new(ProblemKind::Other, None, e.to_string()))
}

/// The client, the request timeout and the token for a setup request to `server`.
fn prepared(
    app: &AppHandle,
    server: &Server,
    token: Option<String>,
) -> std::result::Result<(reqwest::Client, Duration, String), Problem> {
    let state = app.state::<AppState>();
    let token = token_of(&state, token, &[&server.web]).unwrap_or_default();
    Ok((client(&state)?, timeout(&state), token))
}

fn host_of(server: &Server) -> String {
    server.web_url().ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default()
}

fn log_problem(what: &str, server: &Server, p: &Problem) {
    devlog::info("git", format!("setup: {what} on {} failed: {:?} {}", host_of(server), p.kind, p.detail));
}

/// Whom the token belongs to (`None`: a Bitbucket access token without a user).
#[tauri::command]
pub async fn git_setup_account(
    app: AppHandle,
    server: Server,
    token: Option<String>,
) -> Result<Answer<Option<Account>>> {
    let res = async {
        let (client, t, token) = prepared(&app, &server, token)?;
        gitsetup::account(&Api::new(&client, &server, &token, t)?).await
    }
    .await;
    if let Err(p) = &res {
        log_problem("sign-in", &server, p);
    }
    Ok(res.into())
}

/// The repositories of the token's account, newest first.
#[tauri::command]
pub async fn git_setup_repos(app: AppHandle, server: Server, token: Option<String>) -> Result<Answer<Vec<Repo>>> {
    let res = async {
        let (client, t, token) = prepared(&app, &server, token)?;
        gitsetup::list_repos(&Api::new(&client, &server, &token, t)?).await
    }
    .await;
    match &res {
        Ok(list) => devlog::info("git", format!("setup: {} repositories on {}", list.len(), host_of(&server))),
        Err(p) => log_problem("listing repositories", &server, p),
    }
    Ok(res.into())
}

/// Creates a new private repository `name`.
#[tauri::command]
pub async fn git_setup_create(
    app: AppHandle,
    server: Server,
    token: Option<String>,
    name: String,
) -> Result<Answer<Repo>> {
    let res = async {
        let (client, t, token) = prepared(&app, &server, token)?;
        gitsetup::create_repo(&Api::new(&client, &server, &token, t)?, &name).await
    }
    .await;
    match &res {
        Ok(r) => {
            devlog::info("git", format!("setup: private repository {} created on {}", r.full_name, host_of(&server)))
        }
        Err(p) => log_problem("creating a repository", &server, p),
    }
    Ok(res.into())
}

/// Checks the repository before it is saved: server, token, rights, `git ls-remote` through the
/// sync's own git and network, branch and what it holds.
#[tauri::command]
pub async fn git_setup_check(app: AppHandle, server: Server, target: Target, token: Option<String>) -> Result<Check> {
    let state = app.state::<AppState>();
    let url = target.url.trim().to_owned();
    let other = server.provider == gitsetup::Provider::Other;
    let token = if other { token_of(&state, token, &[&url]) } else { token_of(&state, token, &[&server.web, &url]) };
    // Set up again: the branch the sync uses now stays while it holds the notes.
    let gs = state.settings().git_sync;
    let saved = gitsetup::same_repository(&gs.remote_url, &url).then_some(gs.branch).filter(|b| !b.trim().is_empty());
    let git = crate::network::git(&state, token.clone(), &url).with_timeout(Duration::from_secs(60));
    let ls_remote = move || git.version().and_then(|_| git.ls_remote(&url));
    let check = if other {
        gitsetup::check_saved(None, &target, saved.as_deref(), token.as_deref(), ls_remote).await
    } else {
        let client = match client(&state) {
            Ok(c) => c,
            Err(p) => return Ok(failed(p)),
        };
        let api = match Api::new(&client, &server, token.as_deref().unwrap_or_default(), timeout(&state)) {
            Ok(a) => a,
            Err(p) => return Ok(failed(p)),
        };
        gitsetup::check_saved(Some(&api), &target, saved.as_deref(), token.as_deref(), ls_remote).await
    };
    match &check.problem {
        Some(p) => log_problem("check", &server, p),
        None => devlog::info(
            "git",
            format!(
                "setup: check on {} ok, branch {}, content {:?}",
                host_of(&server),
                check.branch.as_deref().unwrap_or("?"),
                check.content
            ),
        ),
    }
    Ok(check)
}

/// A check that could not start (no token, no client, an address that is no web address).
fn failed(p: Problem) -> Check {
    let step = match p.kind {
        ProblemKind::TokenMissing => gitsetup::StepId::Token,
        _ => gitsetup::StepId::Server,
    };
    gitsetup::Check::failed(step, p)
}

#[cfg(test)]
mod tests {
    use super::pick_token;

    #[test]
    fn the_stored_token_only_goes_to_the_server_of_the_saved_repository() {
        let saved = "https://github.com/mia/notizen.git";
        let stored = || Some("ghp_gespeichert".to_owned());
        let pick = |typed: Option<&str>, urls: &[&str]| pick_token(typed.map(str::to_owned), stored, saved, urls);
        // The same server: the stored token (API and repository).
        assert_eq!(
            pick(None, &["https://github.com", "https://github.com/mia/neu.git"]).as_deref(),
            Some("ghp_gespeichert")
        );
        // Another server, or the repository on another one: none (the setup asks for a new token).
        assert_eq!(pick(None, &["https://git.example.org"]), None);
        assert_eq!(pick(None, &["https://github.com", "https://git.example.org/mia/notizen.git"]), None);
        assert_eq!(pick(None, &["https://github.com:8443"]), None);
        assert_eq!(pick(None, &[]), None);
        // A typed token is used wherever it was typed for.
        assert_eq!(pick(Some(" glpat-neu "), &["https://git.example.org"]).as_deref(), Some("glpat-neu"));
        // Nothing saved yet: the stored token stays home.
        assert_eq!(pick_token(None, stored, "", &["https://github.com"]), None);
    }
}
