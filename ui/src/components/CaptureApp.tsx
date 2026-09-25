// The quick-capture window (label "capture", opened by the global shortcut or the tray; kept
// hidden between uses). Text goes into a target – today's daily note, the inbox page, a picked
// or new page (`>`), or the note of the meeting running now; `/zeit` lines are booked. Tab
// cycles the quick targets, Ctrl+Z takes the last capture back for 30 s, a closed window keeps
// its draft.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  CalendarCheck2,
  CalendarDays,
  Check,
  Clipboard,
  Clock,
  CornerDownLeft,
  FilePlus2,
  Hash,
  Inbox,
  NotebookPen,
  Paperclip,
  Search,
  Undo2,
  Users,
} from "lucide-react";
import { api, attachmentUrl, errorText, on, storeFile } from "../lib/api";
import { applyTheme } from "../lib/actions";
import {
  DAILY,
  captureHint,
  captureKind,
  cycleTarget,
  firstDue,
  fold,
  inboxChoice,
  insertBlock,
  loadDraft,
  markdownLink,
  newPageTitle,
  normalizeCapture,
  pastedUrl,
  quickTargets,
  rankPages,
  sameTarget,
  saveDraft,
  tagToken,
  targetPhrase,
  wikiToken,
  type TargetChoice,
} from "../lib/capture";
import { fmtDate } from "../lib/format";
import { IS_MAC } from "../lib/platform";
import { SuggestionPopup, type PopupHandle, type PopupItem } from "../editor/suggestion-popup";
import { lacksReference, referenceOffset, zeitToken, type ZeitToken } from "../editor/zeit-suggest";
import { ZeitConfirm, type ZeitChoice } from "../editor/ZeitConfirm";
import type { CaptureContext, CapturePrefs, Page, PageNode, ZeitGuess } from "../lib/types";
import { resetZeitCache, zeitLaItems, zeitRefItems } from "../editor/zeit-source";
import type { ZeitSuggestItem } from "../editor/extensions";
import { PageIcon } from "./icons";

const ICONS = { zeit: Clock, task: CalendarCheck2, note: NotebookPen };
/** Window width and height range (logical px); the height follows the content. */
const WIDTH = 640;
const MIN_HEIGHT = 112;
const MAX_HEIGHT = 480;
const MAX_LINES = 8;
const MOD = IS_MAC ? "⌘" : "Strg";
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

const DEFAULT_PREFS: CapturePrefs = { default_target: "daily", inbox_title: "Posteingang", selection_shortcut: "", auto_hide_ms: 1200, meeting_target: true };

interface Sugg {
  kind: "zeit" | "wiki" | "tag";
  /** Start of the token that a pick replaces (up to the caret). */
  from: number;
  token?: ZeitToken;
  items: PopupItem[];
}

interface PickItem extends PopupItem {
  choice: TargetChoice;
}

interface Done {
  title: string;
  pageId: number | null;
  queued: boolean;
}

/** Shown after the payload of `capture://shown`. */
interface Shown {
  selection: boolean;
  clipboard: string | null;
}

const flatten = (nodes: PageNode[], out: Page[] = []) => {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
};

function targetIcon(c: TargetChoice, size = 14): ReactNode {
  const p = { size, strokeWidth: 1.9 };
  switch (c.target.kind) {
    case "daily":
      return <CalendarDays {...p} />;
    case "inbox":
      return <Inbox {...p} />;
    case "meeting":
      return <Users {...p} />;
    case "new_page":
      return <FilePlus2 {...p} />;
    default:
      return <PageIcon name={null} size={size} />;
  }
}

const time = (iso: string) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

export function CaptureApp() {
  const draft = useMemo(loadDraft, []);
  const [text, setText] = useState(draft?.text ?? "");
  const [target, setTarget] = useState<TargetChoice>(draft?.target ?? DAILY);
  const [last, setLast] = useState<TargetChoice | null>(null);
  const [prefs, setPrefs] = useState<CapturePrefs>(DEFAULT_PREFS);
  const [ctx, setCtx] = useState<CaptureContext | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [recentIds, setRecentIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sugg, setSugg] = useState<Sugg | null>(null);
  const [picker, setPicker] = useState<{ query: string } | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [clip, setClip] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pickInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const popup = useRef<PopupHandle>(null);
  const pickPopup = useRef<PopupHandle>(null);
  const tags = useRef<[string, number][] | null>(null);
  const hideTimer = useRef<number>(0);
  const height = useRef(0);
  // The text and target of the newest capture: Ctrl+Z puts them back.
  const lastSubmitted = useRef<{ text: string; target: TargetChoice } | null>(null);
  // Clipboard text offered already (not offered again on the next open).
  const offered = useRef<string | null>(null);
  // Latest suggestion request; older answers are dropped.
  const req = useRef(0);
  // Smart /zeit: a single `/zeit 2h …` line without reference asks the AI first.
  const [ask, setAsk] = useState<{ id: number; line: string; guess: ZeitGuess | null } | null>(null);
  const askSeq = useRef(0);
  // Current values for the event handlers registered once.
  const live = useRef({ text, target, last, prefs });
  live.current = { text, target, last, prefs };

  const meetingChoice: TargetChoice | null = ctx?.meeting ? { target: { kind: "meeting", key: ctx.meeting.key }, label: ctx.meeting.title } : null;
  const quick = quickTargets({ inbox: prefs.inbox_title, meeting: meetingChoice, last });

  const focusInput = useCallback(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  /** Focus, again until the window really has it (Windows may keep another app in front). */
  const focusRetry = useCallback(() => {
    focusInput();
    let tries = 0;
    const again = () => {
      if (document.hasFocus() && document.activeElement === (pickInput.current ?? input.current)) return;
      if (++tries > 5) return;
      if (getCurrentWindow().label === "capture") getCurrentWindow().setFocus().catch(() => {});
      (pickInput.current ?? input.current)?.focus();
      window.setTimeout(again, 60 * tries);
    };
    window.setTimeout(again, 40);
  }, [focusInput]);

  const refresh = useCallback(() => {
    api.captureContext().then(setCtx, () => {});
    api.tree().then((t) => setPages(flatten(t)), () => {});
    api.recentPages(12).then((r) => setRecentIds(r.map((p) => p.id)), () => {});
    tags.current = null;
  }, []);

  const loadSettings = useCallback(() => {
    return api
      .settings()
      .then((v) => {
        applyTheme(v.settings.theme, v.settings.appearance);
        const p = { ...DEFAULT_PREFS, ...(v.settings.capture ?? {}) };
        setPrefs(p);
        return p;
      })
      .catch(() => live.current.prefs);
  }, []);

  const defaultTarget = (p: CapturePrefs, lastPage: TargetChoice | null) =>
    p.default_target === "inbox" ? inboxChoice(p.inbox_title) : p.default_target === "last" && lastPage ? lastPage : DAILY;

  useEffect(() => {
    document.body.classList.add("capture-mode");
    loadSettings().then((p) => {
      if (!loadDraft()) setTarget(defaultTarget(p, null));
    });
    refresh();
    focusRetry();
    const shown = (s: Shown | null) => {
      window.clearTimeout(hideTimer.current);
      resetZeitCache();
      setDone(null);
      setError(null);
      setNotice(null);
      setPicker(null);
      refresh();
      loadSettings().then((p) => {
        const cur = live.current;
        // A fresh open starts at the default target; a draft keeps its own.
        if (!cur.text.trim()) setTarget(defaultTarget(p, cur.last));
      });
      const clipText = s?.clipboard?.trim() ? s.clipboard : null;
      if (s?.selection && clipText) {
        const url = pastedUrl(clipText);
        const add = url ?? clipText.replace(/\s+$/, "");
        setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")}\n${add}` : add));
        offered.current = clipText;
        setClip(null);
        if (url) void linkify(url);
      } else setClip(clipText && clipText !== offered.current && !live.current.text.includes(clipText.trim()) ? clipText : null);
      focusRetry();
      // Open latency: the frame after the one that shows the window.
      requestAnimationFrame(() => requestAnimationFrame(() => api.captureReady().catch(() => {})));
    };
    const unlisten = [on<Shown>("capture://shown", shown), on("settings://changed", () => void loadSettings())];
    requestAnimationFrame(() => api.captureReady().catch(() => {}));
    const onFocus = () => (pickInput.current ?? input.current)?.focus();
    window.addEventListener("focus", onFocus);
    document.body.classList.add("ready");
    return () => {
      window.removeEventListener("focus", onFocus);
      unlisten.forEach((u) => u.then((f) => f()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The draft survives closing the window and restarting the app.
  useEffect(() => saveDraft(text.trim() ? { text, target } : null), [text, target]);

  // Auto-grow the field up to MAX_LINES, then the window up to MAX_HEIGHT.
  useLayoutEffect(() => {
    const el = input.current;
    if (el) {
      el.style.height = "auto";
      const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
      el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES)}px`;
    }
    const win = getCurrentWindow();
    if (win.label !== "capture" || !body.current) return;
    const h = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, body.current.offsetHeight + 2)));
    if (h === height.current) return;
    height.current = h;
    win.setSize(new LogicalSize(WIDTH, h)).catch(() => {});
  });

  const hide = () => api.captureHide().catch(() => {});

  // ---------------------------------------------------------- suggestions

  const pageItems = (query: string, limit = 8): PopupItem[] => {
    const byId = new Map(pages.map((p) => [p.id, p]));
    return rankPages(query, pages, recentIds, limit).map((p) => ({
      id: `p${p.id}`,
      title: p.title,
      subtitle: p.parent_id ? byId.get(p.parent_id)?.title : undefined,
      icon: <PageIcon name={p.icon} size={15} />,
    }));
  };

  /** Suggestions for the token before the caret: `/zeit` references (first line), `[[` pages, `#` tags. */
  const suggest = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const id = ++req.current;
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const token = before.includes("\n") ? null : zeitToken(before);
    if (token) {
      (token.kind === "ref" ? zeitRefItems(token.query) : zeitLaItems(token.query))
        .then((items) => id === req.current && setSugg(items.length ? { kind: "zeit", from: token.from, token, items } : null))
        .catch(() => id === req.current && setSugg(null));
      return;
    }
    const wiki = wikiToken(line);
    if (wiki) {
      const items = pageItems(wiki.query);
      const exact = pages.some((p) => fold(p.title) === fold(wiki.query.trim()));
      if (wiki.query.trim() && !exact) items.push({ id: "create", title: `„${wiki.query.trim()}“ neu verlinken`, subtitle: "Seite wird beim Öffnen angelegt", icon: <FilePlus2 size={15} /> });
      return setSugg(items.length ? { kind: "wiki", from: before.length - line.length + wiki.from, items } : null);
    }
    const tag = captureKind(line) === "zeit" ? null : tagToken(line);
    if (tag) {
      const show = (all: [string, number][]) => {
        if (id !== req.current) return;
        const q = fold(tag.query);
        const items = all
          .filter(([t]) => fold(t).startsWith(q) || (q.length > 1 && fold(t).includes(q)))
          .filter(([t]) => t !== tag.query)
          .slice(0, 8)
          .map(([t, n]) => ({ id: `t-${t}`, title: `#${t}`, subtitle: n === 1 ? "1 Seite" : `${n} Seiten`, icon: <Hash size={14} /> }));
        setSugg(items.length ? { kind: "tag", from: before.length - line.length + tag.from, items } : null);
      };
      if (tags.current) show(tags.current);
      else
        api.tags().then((t) => {
          tags.current = t;
          show(t);
        }, () => {});
      return;
    }
    setSugg(null);
  };

  const replaceToken = (from: number, insert: string, swallow = /^\S*/) => {
    const el = input.current;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    const after = text.slice(caret).replace(swallow, "");
    const head = text.slice(0, from) + insert + (after.startsWith(" ") ? "" : " ");
    setText(head + after);
    req.current++;
    setSugg(null);
    requestAnimationFrame(() => el.setSelectionRange(head.length, head.length));
  };

  const pickSugg = (it: PopupItem) => {
    if (!sugg) return;
    if (sugg.kind === "zeit") return replaceToken(sugg.from, (it as ZeitSuggestItem).insert);
    if (sugg.kind === "tag") return replaceToken(sugg.from, it.title);
    const title = it.id === "create" ? (wikiToken(text.slice(sugg.from, input.current?.selectionStart ?? text.length))?.query.trim() ?? "") : it.title;
    replaceToken(sugg.from, `[[${title}]]`, /^[^\s\]]*(\]\])?/);
  };

  // --------------------------------------------------------------- picker

  const pickItems: PickItem[] = useMemo(() => {
    if (!picker) return [];
    const q = picker.query;
    const out: PickItem[] = [];
    const fresh = newPageTitle(q);
    if (fresh) out.push({ id: "new", title: `Neue Seite „${fresh}“ anlegen`, icon: <FilePlus2 size={15} />, section: "Neu", choice: { target: { kind: "new_page", title: fresh }, label: fresh } });
    if (!fresh) {
      for (const c of quick) {
        if (c.target.kind === "page") continue;
        if (!q.trim() || fold(c.label).includes(fold(q.trim())))
          out.push({ id: `q-${JSON.stringify(c.target)}`, title: c.target.kind === "meeting" ? `Jetzt: ${c.label}` : c.label, icon: targetIcon(c, 15), section: "Ziele", choice: c });
      }
      const byId = new Map(pages.map((p) => [p.id, p]));
      for (const p of rankPages(q, pages, recentIds, 8))
        out.push({
          id: `p${p.id}`,
          title: p.title,
          subtitle: p.parent_id ? byId.get(p.parent_id)?.title : undefined,
          icon: <PageIcon name={p.icon} size={15} />,
          section: q.trim() ? "Seiten" : "Zuletzt bearbeitet",
          choice: { target: { kind: "page", page_id: p.id }, label: p.title },
        });
      const title = q.trim();
      if (title && !pages.some((p) => !p.deleted_at && fold(p.title) === fold(title)))
        out.push({ id: "new", title: `Neue Seite „${title}“ anlegen`, hint: `${MOD}+Enter`, icon: <FilePlus2 size={15} />, section: "Neu", choice: { target: { kind: "new_page", title }, label: title } });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, pages, recentIds, ctx, last, prefs.inbox_title]);

  const openPicker = (query = "") => {
    setSugg(null);
    setPicker({ query });
    requestAnimationFrame(() => pickInput.current?.focus());
  };
  const closePicker = () => {
    setPicker(null);
    requestAnimationFrame(focusInput);
  };
  const choose = (c: TargetChoice) => {
    setTarget(c);
    if (c.target.kind === "page" || c.target.kind === "new_page") setLast(c);
    setError(null);
    closePicker();
  };

  // ---------------------------------------------------------------- submit

  const askAi = async (line: string) => {
    const id = ++askSeq.current;
    setAsk({ id, line, guess: null });
    let guess: ZeitGuess | null = null;
    let aiError: unknown = null;
    try {
      guess = await api.zeitSuggestAi(line, null);
    } catch (e) {
      aiError = e;
    }
    if (askSeq.current !== id) return;
    if (guess) return setAsk({ id, line, guess });
    setAsk(null);
    // No AI: the booking's own error, plus how to fix it.
    const err = await submit(line, true);
    if (err && aiError) setError(`${err} – Referenz angeben, z. B. /zeit NP-8801/1020 2h … (KI: ${errorText(aiError)})`);
  };
  const decide = (c: ZeitChoice) => {
    const cur = ask;
    askSeq.current++;
    setAsk(null);
    if (!cur) return;
    if (c === "book" && cur.guess) {
      setText(cur.guess.line);
      submit(cur.guess.line, true);
    } else if (c === "other") {
      const off = referenceOffset(cur.line);
      const next = `${cur.line.slice(0, off)} ${cur.line.slice(off)}`;
      setText(next);
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.setSelectionRange(off, off);
        suggest(next, off);
      });
    } else requestAnimationFrame(() => input.current?.focus());
  };

  /** Submits; returns the error text when it failed. */
  const submit = async (value = text, confirmed = false): Promise<string | null> => {
    if (!value.trim() || busy) return null;
    const single = value.trim();
    if (!confirmed && !single.includes("\n") && lacksReference(single)) {
      await askAi(single);
      return null;
    }
    setBusy(true);
    try {
      const out = await api.captureSubmit(normalizeCapture(value), target.target);
      lastSubmitted.current = { text: value, target };
      setText("");
      setSugg(null);
      setError(null);
      setNotice(null);
      setClip(null);
      saveDraft(null);
      const a = out.appended;
      // A page created now is a page from here on (the next capture goes to the same one).
      if (a && target.target.kind === "new_page") {
        const c: TargetChoice = { target: { kind: "page", page_id: a.page_id }, label: a.title };
        setTarget(c);
        setLast(c);
      }
      const title = a ? a.title : out.bookings.length ? `Zeiterfassung (${out.bookings.map((b) => b.reference).filter(Boolean).join(", ") || "gebucht"})` : "";
      setDone({ title, pageId: a?.page_id ?? null, queued: !!out.queued });
      api.captureContext().then(setCtx, () => {});
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        setDone(null);
        hide();
      }, out.queued ? Math.max(prefs.auto_hide_ms, 2500) : prefs.auto_hide_ms);
      return null;
    } catch (e) {
      setError(errorText(e));
      return errorText(e);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  const recent = ctx?.recent ?? [];
  const undoable = recent[0] && new Date(recent[0].undo_until).getTime() > Date.now() ? recent[0] : null;
  const undo = async () => {
    window.clearTimeout(hideTimer.current);
    try {
      const r = await api.captureUndo();
      setDone(null);
      const prev = lastSubmitted.current;
      if (prev && !live.current.text.trim()) {
        setText(prev.text);
        setTarget(prev.target.target.kind === "new_page" ? prev.target : live.current.target);
        lastSubmitted.current = null;
      }
      setNotice(`Rückgängig gemacht: ${r.preview || r.title}`);
      setError(null);
      api.captureContext().then(setCtx, () => {});
      requestAnimationFrame(focusInput);
    } catch (e) {
      setError(errorText(e));
    }
  };

  // ----------------------------------------------------------------- paste

  const insertAtCaret = (snippet: string, block = false) => {
    const el = input.current;
    const cur = live.current.text;
    const caret = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? caret;
    const res = block ? insertBlock(cur.slice(0, caret) + cur.slice(end), caret, snippet) : { text: cur.slice(0, caret) + snippet + cur.slice(end), caret: caret + snippet.length };
    setText(res.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(res.caret, res.caret);
    });
  };

  /** Replaces a bare pasted address by `[Titel](url)` once the title is known (stays bare offline). */
  const linkify = async (url: string) => {
    const title = await api.linkTitle(url).catch(() => null);
    const md = markdownLink(title, url);
    if (md === url) return;
    setText((t) => {
      let at = t.indexOf(url);
      while (at >= 0 && t[at - 1] === "(") at = t.indexOf(url, at + 1);
      return at < 0 ? t : t.slice(0, at) + md + t.slice(at + url.length);
    });
  };

  const storeFiles = async (files: File[]) => {
    if (!files.length) return;
    setNotice(files.length === 1 ? `„${files[0].name || "Bild"}“ wird gespeichert …` : `${files.length} Dateien werden gespeichert …`);
    const parts: string[] = [];
    for (const f of files) {
      try {
        parts.push((await storeFile(f)).markdown);
      } catch (e) {
        setError(`${f.name || "Datei"} nicht gespeichert: ${errorText(e)}`);
      }
    }
    setNotice(null);
    if (parts.length) insertAtCaret(parts.join("\n"), true);
  };

  const insertClipboard = () => {
    if (!clip) return;
    offered.current = clip;
    const url = pastedUrl(clip);
    insertAtCaret(url ?? clip.replace(/\s+$/, ""), !url && clip.includes("\n"));
    setClip(null);
    if (url) void linkify(url);
  };

  // ------------------------------------------------------------------ keys

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (sugg && popup.current?.onKeyDown({ event: e.nativeEvent } as SuggestionKeyDownProps)) {
      e.preventDefault();
      return;
    }
    const el = e.currentTarget;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (sugg) {
        req.current++;
        setSugg(null);
      } else hide();
    } else if (e.key === "Tab" && !mod && !e.altKey) {
      e.preventDefault();
      setTarget(cycleTarget(quick, target.target, e.shiftKey ? -1 : 1));
      setError(null);
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === "z" && !text && undoable) {
      e.preventDefault();
      void undo();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "v" && clip) {
      e.preventDefault();
      insertClipboard();
    } else if (e.key === ">" && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      openPicker();
    }
  };

  const onPickKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const q = picker?.query ?? "";
    if (e.key === "Enter" && mod) {
      e.preventDefault();
      const title = newPageTitle(q) ?? q.trim();
      if (title) choose({ target: { kind: "new_page", title }, label: title });
      return;
    }
    if (pickPopup.current?.onKeyDown({ event: e.nativeEvent } as SuggestionKeyDownProps)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" || (e.key === "Backspace" && !q)) {
      e.preventDefault();
      closePicker();
    } else if (e.key === " " && !q) {
      // „> “ at the start is a quote, not a target.
      e.preventDefault();
      setPicker(null);
      setText((t) => `> ${t}`);
      requestAnimationFrame(() => input.current?.setSelectionRange(2, 2));
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  // ------------------------------------------------------------------ view

  const kind = captureKind(text.split("\n").find((l) => l.trim()) ?? "");
  const Icon = picker ? Search : ICONS[kind];
  const lines = text.split("\n").filter((l) => l.trim()).length;
  const where = targetPhrase(target);
  const hint = !text.trim()
    ? "Enter speichert · Shift+Enter neue Zeile · Esc schließt"
    : lines > 1
      ? `Enter erfasst ${lines} Zeilen: /zeit bucht, der Rest ${target.target.kind === "daily" ? "geht in die Tagesnotiz" : `wird ${where} gespeichert`} · Esc schließt`
      : `${captureHint(kind, where)} · Esc schließt`;
  const due = picker ? null : firstDue(text);
  const embeds = [...text.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]);
  /** Daily notes read „Tagesnotiz 25.09.2026“ instead of their title. */
  const pageLabel = (id: number | null, title: string) => {
    const daily = id != null ? pages.find((p) => p.id === id)?.daily_date : null;
    return daily ? `Tagesnotiz ${fmtDate(new Date(`${daily}T12:00:00`))}` : title;
  };
  const showRecent = !text && !picker && !done && !ask && recent.length > 0;
  const meetingOffer = meetingChoice && !sameTarget(meetingChoice.target, target.target) ? meetingChoice : null;

  let status: ReactNode;
  if (error) status = error;
  else if (done)
    status = (
      <>
        <Check size={14} strokeWidth={2.4} className="capture-ok" />
        <span>{done.queued ? "Wartet auf die Datenbank – wird gespeichert, sobald sie frei ist" : "Gespeichert in"}</span>
        {!done.queued &&
          (done.pageId != null ? (
            <button type="button" className="capture-link" onClick={() => api.captureOpen(done.pageId!).catch(() => {})}>
              {pageLabel(done.pageId, done.title)}
            </button>
          ) : (
            <b>{done.title}</b>
          ))}
        {undoable && (
          <button type="button" className="capture-undo" onClick={() => void undo()}>
            <Undo2 size={13} /> Rückgängig <kbd>{MOD}+Z</kbd>
          </button>
        )}
      </>
    );
  else if (notice) status = notice;
  else status = picker ? "Enter wählt · " + `${MOD}+Enter legt eine neue Seite an · Esc zurück` : hint;

  return (
    <div className="capture" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
      const files = [...e.dataTransfer.files];
      if (!files.length) return;
      e.preventDefault();
      void storeFiles(files);
    }}>
      <div className="capture-body" ref={body}>
        <div className="capture-targets" role="toolbar" aria-label="Ziel">
          <button
            type="button"
            className={`capture-chip target ${target.target.kind}`}
            onClick={() => (picker ? closePicker() : openPicker())}
            title="Ziel wählen (> am Anfang)"
            aria-label={`Ziel: ${target.label}`}
          >
            {targetIcon(target)}
            <span className="capture-chip-label">{target.target.kind === "meeting" ? `Jetzt: ${target.label}` : target.label}</span>
            {target.target.kind === "new_page" && <span className="capture-new">neu</span>}
          </button>
          {meetingOffer && (
            <button type="button" className="capture-chip meeting" onClick={() => choose(meetingOffer)} title="In die Notiz dieser Besprechung schreiben">
              <Users size={13} strokeWidth={1.9} />
              <span className="capture-chip-label">Jetzt: {meetingOffer.label}</span>
            </button>
          )}
          {clip && !picker && (
            <button type="button" className="capture-chip clip" onClick={insertClipboard} title={clip.slice(0, 200)}>
              <Clipboard size={13} strokeWidth={1.9} />
              <span className="capture-chip-label">Zwischenablage einfügen</span>
              <kbd>{MOD}+⇧+V</kbd>
            </button>
          )}
          <span className="capture-spacer" />
          {!!ctx?.queued && <span className="capture-queued" title="Wird gespeichert, sobald die Datenbank frei ist">{ctx.queued} wartet</span>}
          <span className="capture-tab" aria-hidden>
            <kbd>Tab</kbd> Ziel
          </span>
        </div>
        <div className="capture-field">
          <Icon size={18} strokeWidth={1.75} className="faint" />
          {picker ? (
            <input
              ref={pickInput}
              className="capture-input capture-pick-input"
              value={picker.query}
              placeholder="Seite suchen oder „Neue Seite: Titel“"
              aria-label="Zielseite suchen"
              spellCheck={false}
              autoFocus
              onChange={(e) => setPicker({ query: e.target.value })}
              onKeyDown={onPickKey}
            />
          ) : (
            <textarea
              ref={input}
              className="capture-input"
              rows={1}
              value={text}
              placeholder="Notiz, todo … bis Fr, [[Seite]], #tag oder /zeit NP-8801/1020 1h"
              aria-label="Schnellerfassung"
              aria-autocomplete="list"
              aria-expanded={!!sugg}
              spellCheck={false}
              autoFocus
              disabled={busy}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
                setNotice(null);
                if (done) {
                  window.clearTimeout(hideTimer.current);
                  setDone(null);
                }
                suggest(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length) {
                  e.preventDefault();
                  void storeFiles(files);
                  return;
                }
                const url = pastedUrl(e.clipboardData.getData("text/plain"));
                if (url) {
                  e.preventDefault();
                  insertAtCaret(url);
                  void linkify(url);
                }
              }}
            />
          )}
        </div>
        {(due || embeds.length > 0) && !picker && (
          <div className="capture-meta">
            {due && (
              <span className="capture-pill">
                <CalendarCheck2 size={12} /> fällig {fmtDate(new Date(`${due}T12:00:00`))}
              </span>
            )}
            {embeds.map((name, i) =>
              IMAGE_RE.test(name) ? (
                <img key={`${name}-${i}`} className="capture-thumb" src={attachmentUrl(name)} alt={name} title={name} />
              ) : (
                <span key={`${name}-${i}`} className="capture-pill" title={name}>
                  <Paperclip size={12} /> {name}
                </span>
              ),
            )}
            {embeds.length > 0 && <span className="capture-pill faint">{embeds.length === 1 ? "1 Anhang" : `${embeds.length} Anhänge`}</span>}
          </div>
        )}
        {ask && <ZeitConfirm className="inline" guess={ask.guess} onChoice={decide} />}
        {sugg && !picker && (
          <div className="capture-sugg">
            <SuggestionPopup ref={popup} items={sugg.items} className={sugg.kind === "zeit" ? "zeit" : ""} command={pickSugg} />
          </div>
        )}
        {picker && (
          <div className="capture-sugg capture-picker">
            <SuggestionPopup ref={pickPopup} items={pickItems} empty="Keine Seite gefunden" command={(it) => choose((it as PickItem).choice)} />
          </div>
        )}
        {showRecent && (
          <div className="capture-recent" aria-label="Zuletzt erfasst">
            <div className="capture-recent-head">
              <span>Zuletzt erfasst</span>
              {undoable && (
                <span className="faint">
                  <kbd>{MOD}+Z</kbd> nimmt die letzte zurück
                </span>
              )}
            </div>
            {recent.map((r) => (
              <button
                key={r.id}
                type="button"
                className="capture-recent-item"
                disabled={r.page_id == null}
                onClick={() => r.page_id != null && api.captureOpen(r.page_id).catch(() => {})}
              >
                <span className="capture-recent-time num">{time(r.at)}</span>
                <span className="capture-recent-text">{r.preview || "…"}</span>
                <span className="capture-recent-page">
                  <CornerDownLeft size={11} /> {pageLabel(r.page_id, r.title)}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className={`capture-foot ${error ? "error" : done ? "done" : ""}`}>
          <div className="capture-hint" role={error ? "alert" : done ? "status" : undefined}>
            {status}
          </div>
        </div>
      </div>
    </div>
  );
}
