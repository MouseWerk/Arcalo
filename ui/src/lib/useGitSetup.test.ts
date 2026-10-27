import { describe, expect, it, vi } from "vitest";
import { saveSetup } from "./useGitSetup";

const git = { remote_url: "https://github.com/mia/neu.git", branch: "main", enabled: true as const };

describe("the setup's end", () => {
  it("stores the settings before the new token", async () => {
    const order: string[] = [];
    const save = vi.fn(async () => void order.push("settings"));
    const token = vi.fn(async () => void order.push("token"));
    await saveSetup(git, "ghp_neu", save, token);
    expect(order).toEqual(["settings", "token"]);
    expect(token).toHaveBeenCalledWith("ghp_neu");
  });

  it("settings that could not be stored (a timeout) leave the old token", async () => {
    const save = vi.fn(async () => {
      throw new Error("Einstellungen nicht gespeichert");
    });
    const token = vi.fn(async () => {});
    await expect(saveSetup(git, "ghp_neu", save, token)).rejects.toThrow("nicht gespeichert");
    expect(token).not.toHaveBeenCalled();
  });

  it("a token that could not be stored takes the settings back", async () => {
    const undo = vi.fn(async () => {});
    const save = vi.fn(async () => undo);
    const token = vi.fn(async () => {
      throw new Error("Anmeldeinformationsspeicher gesperrt");
    });
    await expect(saveSetup(git, "ghp_neu", save, token)).rejects.toThrow("gesperrt");
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("without a new token only the settings are stored", async () => {
    const save = vi.fn(async () => {});
    const token = vi.fn(async () => {});
    await saveSetup(git, null, save, token);
    expect(save).toHaveBeenCalledWith(git);
    expect(token).not.toHaveBeenCalled();
  });
});
