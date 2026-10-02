import { describe, expect, it } from "vitest";
import { againModel, downloadPercent, elapsedLabel, isVoiceAudio, meterSegments, stageLabel } from "./voice";
import { slashItems } from "../editor/extensions";
import { isPlayableAudio } from "../editor/fileEmbed";

describe("voice notes", () => {
  it("formats the elapsed time", () => {
    expect(elapsedLabel(0)).toBe("00:00");
    expect(elapsedLabel(65_400)).toBe("01:05");
    expect(elapsedLabel(3_725_000)).toBe("1:02:05");
    expect(elapsedLabel(-5)).toBe("00:00");
  });

  it("lights the meter by level", () => {
    expect(meterSegments(0, 14)).toBe(0);
    expect(meterSegments(Number.NaN, 14)).toBe(0);
    expect(meterSegments(0.01, 14)).toBe(1);
    expect(meterSegments(0.5, 14)).toBe(7);
    expect(meterSegments(2, 14)).toBe(14);
  });

  it("computes download progress", () => {
    expect(downloadPercent(null)).toBe(0);
    expect(downloadPercent({ received: 0, total: 0 })).toBe(0);
    expect(downloadPercent({ received: 250, total: 1000 })).toBe(25);
    expect(downloadPercent({ received: 2000, total: 1000 })).toBe(100);
  });

  it("names the transcription stages", () => {
    expect(stageLabel({ stage: "transcribe", progress: 42 })).toContain("42");
    expect(stageLabel({ stage: "audio", progress: 0 })).not.toBe(stageLabel({ stage: "waiting", progress: 0 }));
  });

  it("offers /voice and finds it as /sprache", () => {
    const on = () => {};
    const items = slashItems({ onTemplate: null, onImage: null, onAi: null, onSummary: null, onDrawing: null, onFile: null, onVoice: on });
    const voice = items.find((i) => i.id === "voice");
    expect(voice).toBeTruthy();
    expect(voice!.keywords).toContain("sprache");
    expect(voice!.keywords).toContain("voice");
    // Without a handler (e.g. the capture window) there is no entry.
    expect(slashItems({ onTemplate: null, onImage: null, onAi: null, onSummary: null, onDrawing: null, onFile: null }).some((i) => i.id === "voice")).toBe(false);
  });

  it("plays recordings inline", () => {
    expect(isPlayableAudio("Sprachnotiz 2026-10-01 14-30.flac")).toBe(true);
    expect(isPlayableAudio("Aufnahme.WAV")).toBe(true);
    expect(isPlayableAudio("Angebot.pdf")).toBe(false);
  });
});

describe("transcribe again", () => {
  it("is offered on a voice note's audio", () => {
    expect(isVoiceAudio("Sprachnotiz 2026-10-01 14-30.flac")).toBe(true);
    expect(isVoiceAudio("rec.WAV")).toBe(true);
    expect(isVoiceAudio("Musik.mp3")).toBe(false);
    expect(isVoiceAudio("Angebot.pdf")).toBe(false);
  });
  it("suggests the model of the settings, else the largest one downloaded", () => {
    const models = [
      { id: "base", installed: true, size: 100 },
      { id: "small", installed: false, size: 400 },
      { id: "large-v3-turbo-q5", installed: true, size: 500 },
    ];
    expect(againModel(models, "base")).toBe("base");
    expect(againModel(models, "small")).toBe("large-v3-turbo-q5");
    expect(againModel(models.map((m) => ({ ...m, installed: false })), "small")).toBe("small");
  });
});
