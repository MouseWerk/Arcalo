import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../lib/api";
import { setLang, t } from "../../lib/i18n";
import type { CliPathInfo } from "../../lib/types";
import { useApp } from "../../store/app";
import { CommandLineGroup, cliDescription } from "./CommandLineGroup";

vi.mock("../../lib/api", async (orig) => {
  const m = await orig<typeof import("../../lib/api")>();
  return { ...m, api: { ...m.api, cliPathInfo: vi.fn(), setCliPath: vi.fn() } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WIN: CliPathInfo = {
  platform: "windows",
  program: "C:\\Users\\a\\AppData\\Local\\Arcalo\\arcalo.exe",
  entry: "C:\\Users\\a\\AppData\\Local\\Arcalo",
  state: "off",
  changeable: true,
};
const MAC: CliPathInfo = {
  platform: "macos",
  program: "/Applications/Arcalo.app/Contents/MacOS/arcalo",
  entry: "/usr/local/bin/arcalo",
  state: "off",
  changeable: true,
};
const LINUX: CliPathInfo = { platform: "linux", program: "/usr/bin/arcalo", state: "on", changeable: false };

describe("Settings → Desktop → Befehlszeile", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  beforeEach(() => {
    vi.mocked(api.cliPathInfo).mockReset();
    vi.mocked(api.setCliPath).mockReset();
    useApp.setState({ toasts: [] } as never);
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = null;
  });

  const show = async (info: CliPathInfo) => {
    vi.mocked(api.cliPathInfo).mockResolvedValue(info);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(CommandLineGroup)));
    return host;
  };
  const toggle = () => host!.querySelector<HTMLButtonElement>('[role="switch"]');

  it("Windows: the switch adds the program folder to the user PATH and shows the new state", async () => {
    await show(WIN);
    expect(host!.querySelector(".set-row-label")?.textContent).toBe("Befehl „arcalo“ im Terminal verfügbar machen");
    expect(host!.textContent).toContain("Trägt den Programmordner in deinen Benutzerpfad (PATH) ein: C:\\Users\\a\\AppData\\Local\\Arcalo.");
    expect(host!.textContent).toContain(WIN.program);
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    vi.mocked(api.setCliPath).mockResolvedValue({ ...WIN, state: "on" });
    await act(async () => toggle()!.click());
    expect(api.setCliPath).toHaveBeenCalledWith(true);
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(host!.textContent).toContain("Der Programmordner steht in deinem Benutzerpfad (PATH)");
    // And off again.
    vi.mocked(api.setCliPath).mockResolvedValue(WIN);
    await act(async () => toggle()!.click());
    expect(api.setCliPath).toHaveBeenLastCalledWith(false);
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  });

  it("a failed change keeps the state and says what failed", async () => {
    await show(WIN);
    vi.mocked(api.setCliPath).mockRejectedValue("Der Benutzerpfad (PATH) wurde nicht geändert: Zugriff verweigert");
    await act(async () => toggle()!.click());
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(toggle()?.disabled).toBe(false);
    expect(useApp.getState().toasts.map((x) => x.title)).toEqual([t("set.cli.addFailed")]);
  });

  it("macOS: the link, its password prompt, and a link to another program", async () => {
    await show({ ...MAC, state: "elsewhere", other: "/Applications/Annalo.app/Contents/MacOS/annalo" });
    expect(host!.textContent).toContain("/usr/local/bin/arcalo verweist auf /Applications/Annalo.app/Contents/MacOS/annalo. Einschalten ersetzt den Verweis");
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    // A cancelled password prompt: the state as it is, no message.
    vi.mocked(api.setCliPath).mockResolvedValue({ ...MAC, state: "elsewhere", other: "/Applications/Annalo.app/Contents/MacOS/annalo" });
    await act(async () => toggle()!.click());
    expect(useApp.getState().toasts).toEqual([]);
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  });

  it("macOS from the disk image: no switch, the reason instead", async () => {
    await show({ ...MAC, changeable: false, note: "Zieh Arcalo zuerst in den Ordner „Programme“ und starte es von dort." });
    expect(toggle()).toBeNull();
    expect(host!.querySelector(".set-row-label")?.textContent).toBe("Befehl „arcalo“ im Terminal");
    expect(host!.textContent).toContain("Zieh Arcalo zuerst in den Ordner „Programme“");
    expect(host!.textContent).toContain(t("set.cli.notOnPath"));
  });

  it("Linux and the Store package: only where the program is", async () => {
    await show(LINUX);
    expect(toggle()).toBeNull();
    expect(host!.textContent).toContain("Das Paket hat den Befehl eingerichtet.");
    expect(host!.textContent).toContain(t("set.cli.available"));
    expect(host!.textContent).toContain("/usr/bin/arcalo");
    expect(api.setCliPath).not.toHaveBeenCalled();
    expect(cliDescription({ ...WIN, state: "managed", changeable: false }, t)).toBe(t("set.cli.store"));
    expect(cliDescription({ ...LINUX, program: "/home/a/Arcalo.AppImage", state: "off" }, t)).toBe(t("set.cli.linuxOff"));
  });

  it("speaks English", async () => {
    setLang("en");
    expect(cliDescription({ ...MAC, state: "on" }, t)).toBe("/usr/local/bin/arcalo points to this program.");
    expect(cliDescription(WIN, t)).toBe("Adds the program folder to your user PATH: C:\\Users\\a\\AppData\\Local\\Arcalo. Applies to every newly opened terminal.");
  });
});
