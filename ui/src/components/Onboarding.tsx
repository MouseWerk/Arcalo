// First start: choose between sample data, an empty workspace and an Obsidian import.

import { useEffect, useRef, useState } from "react";
import { FilePlus2, FolderInput, LayoutDashboard, Server } from "lucide-react";
import { AnnaloLogo } from "./Logo";
import { api } from "../lib/api";
import { importVault } from "../lib/actions";
import { useApp } from "../store/app";

export function Onboarding() {
  const [busy, setBusy] = useState(false);
  const s = useApp.getState;
  const finish = async (samples: boolean) => {
    setBusy(true);
    try {
      await api.finishOnboarding(samples);
      await s().refreshTree();
      s().bumpWbs();
      s().set({ onboarding: false });
      if (samples) {
        const welcome = [...s().pages.values()].find((p) => p.title === "Willkommen");
        if (welcome) s().openPage(welcome.id);
      }
    } catch (e) {
      s().error("Start fehlgeschlagen", e);
    } finally {
      setBusy(false);
    }
  };
  const choices = [
    {
      icon: FilePlus2,
      title: "Leer starten",
      text: "Ein leerer Arbeitsbereich für deine eigenen Notizen und Projekte.",
      run: () => finish(false),
    },
    {
      icon: FolderInput,
      title: "Obsidian-Vault importieren",
      text: "Ordner, [[Links]], #Tags, Eigenschaften und Bilder werden übernommen.",
      run: async () => {
        await finish(false);
        await importVault();
      },
    },
    {
      icon: LayoutDashboard,
      title: "Mit Beispieldaten erkunden",
      text: "Ein Beispielprojekt mit Netzplänen, Buchungen und Notizen. Lässt sich später in den Einstellungen entfernen.",
      run: () => finish(true),
    },
  ];
  const first = useRef<HTMLButtonElement>(null);
  const run = useRef(choices.map((c) => c.run));
  run.current = choices.map((c) => c.run);
  useEffect(() => {
    first.current?.focus();
    // 1 / 2 / 3 pick a choice (not while typing somewhere else, e.g. the palette).
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest("input, textarea, [contenteditable], .overlay")) return;
      const i = ["1", "2", "3"].indexOf(e.key);
      if (i < 0) return;
      e.preventDefault();
      run.current[i]?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="home">
      <div className="home-inner onboarding">
        <div className="onb-mark" aria-hidden>
          <AnnaloLogo size={34} />
        </div>
        <h1>Willkommen bei Annalo</h1>
        <p className="muted">Notizen, Projekte und Zeiterfassung an einem Ort. Wie möchtest du beginnen?</p>
        <div className="onb-choices">
          {choices.map((c, i) => (
            <button key={c.title} ref={i === 0 ? first : undefined} type="button" className="onb-choice" disabled={busy} onClick={c.run} aria-keyshortcuts={String(i + 1)}>
              <kbd className="onb-key" aria-hidden>
                {i + 1}
              </kbd>
              <c.icon size={20} strokeWidth={1.75} />
              <span className="onb-title">{c.title}</span>
              <span className="onb-text">{c.text}</span>
            </button>
          ))}
        </div>
        <button type="button" className="onb-server" onClick={() => s().openTab({ kind: "settings" })}>
          <Server size={14} strokeWidth={1.75} /> KI-Anbieter jetzt einrichten (LiteLLM, OpenAI, Ollama …)
        </button>
      </div>
    </div>
  );
}
