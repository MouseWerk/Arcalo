# Network in organizations

Settings → Netzwerk has named **proxy profiles** and decides per **service** which profile a
connection takes. Profiles are per computer: they are not part of the settings sync, and a
profile's proxy password lives in the credential store (account `proxy-password` for the
profile „Standard“, `proxy-password-<profile id>` for the others).

## Profiles

Each profile has a mode – direct, system (Windows: WinINet of the user, incl. `AutoConfigURL`
shown as a hint; elsewhere `HTTP(S)_PROXY`/`NO_PROXY`), manual (HTTP, HTTPS and SOCKS5 proxy
with user and password) or PAC (URL or `file://`; evaluated by the app in a sandbox) – an
exception list, extra root CAs (PEM or DER file) and connect/read timeouts.

The profile „Standard“ (id `standard`) always exists and is used by every service that is
not routed elsewhere. Settings of 1.9 and older become this profile unchanged. Connections that
1.9 kept out of the proxy settings („Anwenden auf“ off) are routed to a copy of it named
„Standard (System)“ in mode `system`.

## Services

| Service key | Connection |
|---|---|
| `updates` | update feed and download |
| `release_notes` | release notes of other versions (GitHub) |
| `voice_models` | Whisper model downloads |
| `ai`, `ai:<provider id>` | AI providers (all, or one) |
| `jira`, `jira:<site id>` | Jira sites |
| `git_sync` | Git sync (`git` with `http_proxy`/`https_proxy`/`no_proxy`, CA bundle, pinned key) |
| `ics`, `ics:<calendar id>` | ICS subscriptions |
| `link_preview` | titles of pasted links |
| `http_tool` | the assistant's `http_request` tool |

Outlook calendars and mail are local and use no network profile. A local AI provider
(„Proxy umgehen“, e.g. Ollama) goes direct while it is on the default profile.

## Trusted servers

„Diesem Server vertrauen“ stores the host with the SHA-256 of its leaf certificate. For that host
exactly this certificate is accepted and any other is rejected (also one a CA vouches for). Git
pins the server's public key instead (`http.pinnedPubkey`). The global „Ungültige Zertifikate
akzeptieren“ of 1.9 is kept on the profiles that had it (shown „unsicher“) until „In vertraute
Server umwandeln“.

## Policies

Read like the update policies (docs/admin/updates.md): HKLM over HKCU
(`Software\Policies\MouseWerk\Arcalo`), macOS managed preferences, `policy.json`.

| Key | Type | Values |
|---|---|---|
| `NetworkRoute.<service key>` | string | name or id of a profile, or `Standard`: the service must use it; Settings shows its dropdown locked. A group key (`NetworkRoute.ai`) covers every service of the group; a key with an id wins over its group. |
| `LockNetworkProfiles` | DWORD / bool | `1`: profiles cannot be added, changed or deleted, nor their passwords |

A route naming a profile this computer does not have is ignored and logged (Settings →
Protokoll, category „net“). Profiles themselves are not distributed by policy; create them on
the computer (or keep the default profile, e.g. in mode `system` or `pac`, and route single
services to `Standard`).

### Registry example (.reg)

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\Software\Policies\MouseWerk\Arcalo]
"NetworkRoute.updates"="Standard"
"NetworkRoute.ai"="Firma"
"NetworkRoute.jira:intern"="VPN"
"LockNetworkProfiles"=dword:00000001
```

### policy.json example

```json
{
  "NetworkRoute.git_sync": "VPN",
  "NetworkRoute.ai": "Firma",
  "LockNetworkProfiles": true
}
```

## Log

With the developer log at Debug, each request logs `net` lines with the service, the profile
and the route (`ai:litellm [Firma] https://llm.firma.de → proxy http://firma:8080`): scheme and
host only, never paths, tokens or proxy credentials.
