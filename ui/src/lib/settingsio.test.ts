import { describe, expect, it } from "vitest";
import { EXPORT_FORMAT, parseSettingsImport, settingsDiff, showValue } from "./settingsio";
import type { Settings } from "./types";

/** A settings object shaped like the shell's (the parts the checks need). */
const current = (): Settings =>
  ({
    litellm_base_url: "http://localhost:4000",
    router: { local_model: "ollama/llama3.2", standard_model: "cloud-standard", reasoning_model: "cloud-reasoning", standard_threshold: 30, reasoning_threshold: 60, private_markers: ["#privat"] },
    auto_route: true,
    embedding_model: null,
    assistant_instructions: "",
    thresholds: { warning: 0.75, critical: 0.9 },
    idle_threshold_minutes: 5,
    pernr: null,
    jira_issue_map: {},
    theme: "system",
    open_daily_on_start: false,
    daily_target_hours: 8,
    workdays: [1, 2, 3, 4, 5],
    backup_dir: null,
    backup_keep: 14,
    markdown_mirror: true,
    markdown_mirror_dir: null,
    daily_template: null,
    close_to_tray: false,
    reminder_time: "17:30",
    capture_shortcut: "Ctrl+Shift+Space",
    palette_shortcut: null,
    auto_update_check: true,
    git_sync: { enabled: false, remote_url: "", branch: "main", author_name: "Annalo", author_email: "a@b", include_database: false, mode: "with_backup" },
    network: {
      mode: "system",
      http_proxy: "",
      https_proxy: "",
      socks_proxy: "",
      no_proxy: "localhost",
      pac_url: "",
      pac_results: {},
      proxy_user: "",
      extra_ca_path: null,
      accept_invalid_certs: false,
      timeout_secs: 30,
      apply_to: { ai: true, git: true, updates: true, tools: true },
    },
    appearance: { accent: "indigo", ui_font: "inter", editor_font: "sans", code_font: "jetbrains", ui_scale: 100, density: "normal", line_width: "normal", reduce_motion: false, mica: true, custom_titlebar: true, startup_animation: true },
    editor: { spellcheck: "de", autosave_ms: 450, smart_quotes: false, auto_pair: false, tab_size: 4, code_line_numbers: false, hover_preview: true, hover_delay_ms: 450, scroll_outline: true, default_icon: null, new_page_location: "top", inbox_title: "Inbox" },
    notes: { daily_title: "iso", daily_folder: "Journal", trash_retention_days: 30, version_interval_minutes: 10, max_versions: 50 },
    time: { week_start: "monday", rounding: { step_minutes: 0, mode: "up", min_minutes: 0 }, hours_display: "decimal", default_leistungsart: {}, cats_delimiter: "semicolon", cats_columns: "standard", export_file_pattern: "zeiten-{von}-{bis}" },
    ai: { temperature: 0.3, max_tokens: null, inline_presets: null, meeting_template: null, monthly_cost_limit_usd: null, citations: true, streaming: true, allowed_tools: ["log_time"] },
    notifications: { end_of_day: true, late_timer: true, budget: true, backup_failed: true, git_failed: true, updates: true, quiet_hours: false, quiet_from: "22:00", quiet_to: "07:00" },
    privacy: { read_open_page: true, local_only: false },
    start: { open: "tabs", restore_window: true, minimized: false },
    locale: { language: "de", date_format: "de" },
    keymap: {},
  }) as Settings;

const file = (settings: unknown) => JSON.stringify({ format: EXPORT_FORMAT, version: 1, app_version: "1.0.0", settings });

describe("settings import", () => {
  it("rejects files that are not settings", () => {
    expect(parseSettingsImport("{kaputt", current()).error).toMatch(/kein gültiges JSON/);
    expect(parseSettingsImport("[1,2]", current()).error).toMatch(/keine Einstellungen/);
    expect(parseSettingsImport(JSON.stringify({ format: "andere-app", settings: {} }), current()).error).toMatch(/keine Annalo/);
    expect(parseSettingsImport(JSON.stringify({ format: EXPORT_FORMAT, version: 99, settings: { theme: "dark" } }), current()).error).toMatch(/neueren/);
    expect(parseSettingsImport(JSON.stringify({ foo: 1 }), current()).error).toMatch(/keine bekannten/);
  });

  it("merges known values, skips unknown keys and wrong types with warnings", () => {
    const r = parseSettingsImport(
      file({
        theme: "dark",
        backup_keep: "viele",
        wer_bin_ich: 1,
        appearance: { accent: "teal", density: "compact", neu: true },
        workdays: [1, 2, 3],
        jira_issue_map: { "NP-1": "AET-1", "NP-2": 5 },
        network: { mode: "manual", http_proxy: "proxy:8080", apply_to: { git: false } },
        reminder_time: null,
        embedding_model: "firma-embed",
        keymap: { daily_note: "Ctrl+Shift+J" },
        ai: { allowed_tools: ["log_time", 7] },
      }),
      current(),
    );
    expect(r.error).toBeNull();
    const s = r.settings!;
    expect(s.theme).toBe("dark");
    expect(s.backup_keep).toBe(14);
    expect(s.appearance.accent).toBe("teal");
    expect(s.appearance.density).toBe("compact");
    expect(s.appearance.ui_scale).toBe(100);
    expect(s.workdays).toEqual([1, 2, 3]);
    expect(s.jira_issue_map).toEqual({ "NP-1": "AET-1" });
    expect(s.network.mode).toBe("manual");
    expect(s.network.apply_to).toEqual({ ai: true, git: false, updates: true, tools: true });
    expect(s.reminder_time).toBeNull();
    expect(s.embedding_model).toBe("firma-embed");
    expect(s.keymap).toEqual({ daily_note: "Ctrl+Shift+J" });
    expect(s.ai.allowed_tools).toEqual(["log_time"]);
    expect("wer_bin_ich" in s).toBe(false);
    expect(r.warnings.join("\n")).toMatch(/backup_keep: Zahl erwartet/);
    expect(r.warnings.join("\n")).toMatch(/wer_bin_ich: unbekannte Einstellung/);
    expect(r.warnings.join("\n")).toMatch(/appearance\.neu/);
    expect(r.warnings.join("\n")).toMatch(/jira_issue_map\.NP-2/);
    expect(r.warnings.join("\n")).toMatch(/ai\.allowed_tools/);
  });

  it("accepts a bare settings object and lists the changes", () => {
    const cur = current();
    const r = parseSettingsImport(JSON.stringify({ theme: "light", time: { rounding: { step_minutes: 15 } } }), cur);
    const diff = settingsDiff(cur, r.settings);
    expect(diff.map((d) => d.path)).toEqual(["theme", "time.rounding.step_minutes"]);
    expect(diff[1]).toEqual({ path: "time.rounding.step_minutes", from: 0, to: 15 });
    expect(settingsDiff(cur, current())).toEqual([]);
    // Records are compared as a whole.
    const withMap = { ...cur, jira_issue_map: { a: "1" } };
    expect(settingsDiff(cur, withMap).map((d) => d.path)).toEqual(["jira_issue_map"]);
    expect(showValue(true)).toBe("an");
    expect(showValue(null)).toBe("–");
    expect(showValue("x".repeat(100)).length).toBe(58);
  });

  it("round-trips an export of the current settings without changes", () => {
    const cur = current();
    const r = parseSettingsImport(file(cur), cur);
    expect(r.warnings).toEqual([]);
    expect(settingsDiff(cur, r.settings)).toEqual([]);
  });
});
