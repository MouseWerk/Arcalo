# Developing Arcalo on a Mac

How to build, test and release Arcalo from a MacBook (Apple Silicon or Intel), including working with
Claude Code locally. The working rules are in `CLAUDE.md`; quality plans and findings in `docs/quality/`.

## 1. Tools (once)

```sh
xcode-select --install                                   # compiler, git
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install rustup node@22 cmake                        # cmake: whisper.cpp (voice notes)
rustup-init -y                                           # rust-toolchain.toml then picks 1.94.1 by itself
cargo install tauri-cli --version "^2" --locked
```

Git identity (so every commit is yours without extra flags):

```sh
git config --global user.name  "Maurice Kleindienst"
git config --global user.email "kleindiema@gmail.com"
```

GitHub access: `brew install gh && gh auth login` (HTTPS) or an SSH key added to your GitHub account.

## 2. Repositories

```sh
mkdir -p ~/Projekte && cd ~/Projekte
git clone https://github.com/MouseWerk/Arcalo.git
git clone https://github.com/MouseWerk/annaloweb.git     # website, deploys to Cloudflare on push to main
cd Arcalo && npm ci --prefix ui && npm ci --prefix e2e
```

## 3. Run and check

| What | Command |
|---|---|
| Run the app with hot reload | `cd src-tauri && cargo tauri dev` |
| Format, lint, Rust tests | `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p annalo-core -p annalo -p annalo-cli` |
| UI typecheck and unit tests | `npm --prefix ui run typecheck && npm --prefix ui test` |
| Build a Mac app and DMG | `cd src-tauri && cargo tauri build --bundles app,dmg` |

Note: the macOS CI job runs `cargo clippy -p annalo` on a Mac. Mac-only code (Touch ID, Keychain, menu) is
only compiled there, so run clippy locally before pushing changes to it.

## 4. End-to-end tests

The e2e suite (WebdriverIO + tauri-driver) cannot run natively on macOS: WKWebView has no WebDriver. Three
options, in order of convenience:

1. **Docker** (Docker Desktop, OrbStack or Colima): `e2e/docker/run.sh` builds a Linux image like the CI job
   and runs the suite in it; pass test files to run only those, e.g.
   `e2e/docker/run.sh tests/01-notes.test.js`. The Linux build and node_modules live in Docker volumes, so the
   Mac's own `target/` and `node_modules` are not touched. The first run takes a while (image, crates, build).
   This setup was written without a Mac or Docker at hand; if a step fails, fix it here.
2. **GitHub CI**: every push to `main` runs the full suite on Linux plus the Windows installer, the MSIX package
   and the macOS bundle (about 2.5 h; superseded runs are cancelled automatically).
3. **A Linux VM** (UTM with Ubuntu 24.04): install the packages from the `core` job of `.github/workflows/ci.yml`
   and run `e2e/run.sh`.

## 5. Release

1. Everything merged and pushed to `main`, CI green.
2. GitHub → Actions → Release → Run workflow, version e.g. `1.12.0` (or `gh workflow run release.yml -f version=1.12.0`).
3. Check the release page (installers, `latest.json`, signatures), then update the website repo (changelog,
   version, screenshots) and push it.
4. Windows: go through the "Checklist for Windows (manual)" in the release notes on a Windows PC.

Never commit the update-signing private key; it lives only in the repository secrets.

## 6. Claude Code on the Mac

```sh
npm install -g @anthropic-ai/claude-code    # or the installer from the Claude Code docs
cd ~/Projekte/Arcalo && claude
```

`CLAUDE.md` is read automatically, so the standing rules apply from the first message. Differences to the
cloud sessions used so far:

- Commits use your global git identity (step 1); pushing uses your own GitHub login, so force pushes, tag
  updates and release deletion work if you ask for them (the cloud proxy blocked those).
- Connectors such as Google Drive are set up in Claude Code with `/mcp` or in the Claude settings.
- Parallel agents in worktrees work the same way; the e2e suite runs through Docker (section 4).
- Marketing material is in Google Drive, folder "Arcalo Marketing"; packaging and store steps in `docs/release/`.
