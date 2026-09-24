// „Versionen…“: earlier states of a page, preview, line diff and restore.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { History, RotateCcw, Save } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Button, Dialog, Segmented, Spinner } from "../components/ui";
import { flushAllEditors, reloadEditors } from "../editor/NoteEditor";
import { dateLong, fileSize, relative, time, versionTimes } from "../lib/format";
import { collapseDiff, lineDiff } from "../lib/linediff";
import type { VersionInfo } from "../lib/types";

export function VersionsDialog({ page, open, onClose }: { page: { id: number; title: string }; open: boolean; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [content, setContent] = useState<Record<number, string>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [mode, setMode] = useState<"text" | "diff">("text");
  const [busy, setBusy] = useState(false);
  const s = useApp.getState;

  const load = async (select?: number) => {
    // Pending edits first, so „aktuell“ and a new snapshot match what the editor shows.
    await flushAllEditors().catch(() => {});
    const [list, doc] = await Promise.all([api.versions(page.id), api.page(page.id)]);
    setVersions(list);
    setCurrent(doc.content);
    setSelected(select ?? list[0]?.id ?? null);
  };

  useEffect(() => {
    if (!open) return;
    setVersions(null);
    setContent({});
    load().catch((e) => s().error("Versionen konnten nicht geladen werden", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, page.id]);

  useEffect(() => {
    if (selected == null || content[selected] != null) return;
    api
      .versionContent(selected)
      .then((c) => setContent((m) => ({ ...m, [selected]: c })))
      .catch((e) => s().error("Version konnte nicht geladen werden", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const text = selected != null ? content[selected] : undefined;
  // Restoring the state the page already has would only add a version.
  const same = text != null && current != null && text === current;
  const interval = useApp.getState().settings?.settings.notes?.version_interval_minutes ?? 10;
  const diff = useMemo(() => (mode === "diff" && text != null && current != null ? lineDiff(current, text) : null), [mode, text, current]);
  const changes = diff?.filter((l) => l.kind !== "same").length ?? 0;
  const rows = useMemo(() => (diff ? collapseDiff(diff) : null), [diff]);
  const labels = useMemo(() => versionTimes((versions ?? []).map((v) => v.created_at)), [versions]);
  const diffRef = useRef<HTMLPreElement>(null);
  // Scroll the first change into view (the text above it is mostly folded anyway).
  useLayoutEffect(() => {
    const first = diffRef.current?.querySelector<HTMLElement>(".diff-add, .diff-del");
    if (first && diffRef.current) diffRef.current.scrollTop = Math.max(0, first.offsetTop - diffRef.current.offsetTop - 40);
  }, [rows]);

  const snapshot = async () => {
    setBusy(true);
    try {
      await flushAllEditors();
      const id = await api.snapshotPage(page.id);
      if (id == null) s().toast({ tone: "info", title: "Keine Änderung", detail: "Die neueste Version entspricht schon dem aktuellen Stand." });
      else s().toast({ tone: "success", title: "Version gesichert" });
      await load(id ?? undefined);
    } catch (e) {
      s().error("Version konnte nicht gesichert werden", e);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const v = versions?.find((x) => x.id === selected);
    if (!v) return;
    const ok = await s().confirm({
      title: "Version wiederherstellen?",
      message: `„${page.title}“ bekommt den Stand vom ${dateLong(v.created_at)}, ${time(v.created_at)}. Der jetzige Inhalt bleibt als Version erhalten.`,
      confirmLabel: "Wiederherstellen",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await flushAllEditors();
      await api.restoreVersion(page.id, v.id);
      reloadEditors([page.id]);
      s().toast({ tone: "success", title: "Version wiederhergestellt" });
      onClose();
    } catch (e) {
      s().error("Wiederherstellen fehlgeschlagen", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Versionen"
      description={`Frühere Stände von „${page.title}“`}
      width={860}
      footer={
        <>
          <Button icon={Save} onClick={snapshot} loading={busy} className="versions-snapshot">
            Jetzt Version sichern
          </Button>
          <span className="spacer" style={{ flex: 1 }} />
          <Button onClick={onClose}>Schließen</Button>
          <Button variant="primary" icon={RotateCcw} onClick={restore} disabled={busy || selected == null || text == null || same} title={same ? "Entspricht dem aktuellen Stand" : undefined}>
            Wiederherstellen
          </Button>
        </>
      }
    >
      {versions == null ? (
        <div className="center-fill">
          <Spinner />
        </div>
      ) : versions.length === 0 ? (
        <div className="versions-empty faint">
          <History size={18} /> Noch keine Versionen. Sie entstehen beim Bearbeiten oder mit „Jetzt Version sichern“.
        </div>
      ) : (
        <div className="versions">
          <div className="versions-list" role="listbox" aria-label="Versionen">
            {versions.map((v, i) => (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={selected === v.id}
                className={`versions-item ${selected === v.id ? "on" : ""}`}
                title={`${dateLong(v.created_at)}, ${time(v.created_at)}`}
                onClick={() => setSelected(v.id)}
              >
                <span className="versions-when num">
                  {labels[i]}
                  {i === 0 && <span className="versions-tag">{content[v.id] != null && content[v.id] === current ? "Aktuell" : "Neueste"}</span>}
                </span>
                <span className="versions-meta faint">
                  {relative(v.created_at)} · {fileSize(v.size)}
                </span>
              </button>
            ))}
            <p className="versions-note faint">
              Beim Bearbeiten höchstens alle {interval} Min. gesichert, 30 Tage aufbewahrt.
            </p>
          </div>
          <div className="versions-preview">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: "text", label: "Inhalt" },
                { value: "diff", label: "Unterschiede zu jetzt" },
              ]}
            />
            {text == null ? (
              <div className="center-fill">
                <Spinner />
              </div>
            ) : mode === "text" ? (
              <pre className="versions-pre">{text}</pre>
            ) : (
              <>
                <div className="versions-legend faint">
                  {changes === 0 ? "Keine Unterschiede zum aktuellen Stand." : <><span className="diff-del">− nur jetzt</span> <span className="diff-add">+ nur in dieser Version</span></>}
                </div>
                <pre className="versions-pre versions-diff" ref={diffRef}>
                  {rows?.map((l, i) =>
                    l.kind === "skip" ? (
                      <div key={i} className="diff-skip">
                        … {l.count} unveränderte Zeilen
                      </div>
                    ) : (
                      <div key={i} className={`diff-${l.kind}`}>
                        {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}
                        {l.text || " "}
                      </div>
                    ),
                  )}
                </pre>
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
