// Images of the issue view: avatars, inline images and thumbnails, loaded through the site's client
// (`jira_image`, the login only to the site itself) when they come into view, a few at a time; the
// rendered HTML of Jira with its links and images wired up; a viewer for an image.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fullApi, openIssueView, sanitizeJiraHtml, type IssueFull, type JUser } from "../../lib/issueFull";
import { t } from "../../lib/i18n";
import { isKey } from "../../lib/ime";
import { useApp } from "../../store/app";

// ------------------------------------------------------------------ loading

const loaded = new Map<string, string>();
const waiting = new Map<string, Promise<string>>();
const queue: (() => void)[] = [];
let running = 0;
/** Images asked for at once: 100 thumbnails do not all go out together. */
const PARALLEL = 4;

function next() {
  while (running < PARALLEL && queue.length) {
    running++;
    queue.shift()!();
  }
}

/** An image of `site` as a data URL (cached for the session). */
export function loadImage(site: string, url: string): Promise<string> {
  const hit = loaded.get(url);
  if (hit) return Promise.resolve(hit);
  const pending = waiting.get(url);
  if (pending) return pending;
  const p = new Promise<string>((resolve, reject) => {
    queue.push(() => {
      fullApi
        .image(site, url)
        .then((data) => {
          loaded.set(url, data);
          resolve(data);
        }, reject)
        .finally(() => {
          waiting.delete(url);
          running--;
          next();
        });
    });
    next();
  });
  waiting.set(url, p);
  return p;
}

/** Loads `url` once the element is (nearly) in view. */
export function useLazyImage(site: string, url: string | null): [React.RefObject<HTMLElement | null>, string | null, boolean] {
  const ref = useRef<HTMLElement | null>(null);
  const [data, setData] = useState<string | null>(url ? (loaded.get(url) ?? null) : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!url) return setData(null);
    const hit = loaded.get(url);
    if (hit) return setData(hit);
    setData(null);
    const el = ref.current;
    let alive = true;
    const start = () => loadImage(site, url).then((d) => alive && setData(d), () => alive && setFailed(true));
    if (!el || typeof IntersectionObserver === "undefined") {
      void start();
      return () => void (alive = false);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          void start();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [site, url]);
  return [ref, data, failed];
}

// ------------------------------------------------------------------ avatars

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** A user's avatar (initials until it is loaded, or when there is none). */
export function Avatar({ user, site, size = "md" }: { user: JUser | null; site: string; size?: "sm" | "md" | "lg" }) {
  const [ref, data] = useLazyImage(site, user?.avatar || null);
  return (
    <span ref={ref as React.RefObject<HTMLSpanElement>} className={`iv-avatar iv-avatar-${size}`} aria-hidden>
      {data ? <img src={data} alt="" /> : initials(user?.name ?? "")}
    </span>
  );
}

/** Avatar and name. */
export function UserChip({ user, site, empty }: { user: JUser | null; site: string; empty?: string }) {
  if (!user) return <span className="faint">{empty ?? t("jira.unassigned")}</span>;
  return (
    <span className="iv-user">
      <Avatar user={user} site={site} size="sm" />
      <span className="ellipsis">{user.name}</span>
    </span>
  );
}

// ------------------------------------------------------------------ the image viewer

interface Shown {
  src: string;
  alt: string;
}
let showViewer: ((s: Shown | null) => void) | null = null;

export function openImageViewer(src: string, alt: string) {
  showViewer?.({ src, alt });
}

/** The image viewer over the issue view (Esc or a click closes it). */
export function ImageViewer() {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    showViewer = setShown;
    return () => void (showViewer = null);
  }, []);
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (isKey(e, "Escape")) {
        e.stopPropagation();
        setShown(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown]);
  if (!shown) return null;
  return createPortal(
    <div className="overlay iv-viewer" role="dialog" aria-modal="true" aria-label={shown.alt || t("iv.image")} onMouseDown={() => setShown(null)}>
      <img src={shown.src} alt={shown.alt} />
      <button type="button" className="iv-viewer-close" aria-label={t("common.close")} onClick={() => setShown(null)}>
        <X size={18} />
      </button>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ Jira's HTML

/** Opens a link of Jira's HTML: an issue of the site in the view, anything else in the browser. */
export function followLink(href: string, issueKey?: string | null) {
  if (issueKey) return openIssueView(issueKey);
  void openUrl(href).catch((e) => useApp.getState().error(t("jira.openFailed"), e));
}

/**
 * Jira's rendered HTML (description, comments, text fields), sanitized; its images load through
 * the site's client as they come into view, a click shows them large; links open the issue in the
 * view or the page in the browser.
 */
export function JiraHtml({ html, issue, className = "" }: { html: string; issue: Pick<IssueFull, "site" | "base" | "attachments">; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const safe = useMemo(() => sanitizeJiraHtml(html, issue.base), [html, issue.base]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const imgs = [...el.querySelectorAll<HTMLImageElement>("img[data-jira-src], img[data-media-alt]")];
    let alive = true;
    const load = (img: HTMLImageElement) => {
      let url = img.dataset.jiraSrc ?? "";
      if (!url && img.dataset.mediaAlt) {
        const att = issue.attachments.find((a) => a.filename === img.dataset.mediaAlt);
        url = att?.thumbnail || att?.content || "";
      }
      if (!url) return void img.classList.add("iv-img-missing");
      img.classList.add("iv-img-loading");
      loadImage(issue.site, url).then(
        (d) => {
          if (!alive) return;
          img.src = d;
          img.classList.remove("iv-img-loading");
        },
        () => alive && (img.classList.remove("iv-img-loading"), img.classList.add("iv-img-missing")),
      );
    };
    if (typeof IntersectionObserver === "undefined") {
      imgs.forEach(load);
      return () => void (alive = false);
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          load(e.target as HTMLImageElement);
        }
      },
      { rootMargin: "300px" },
    );
    imgs.forEach((i) => io.observe(i));
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [safe, issue.site, issue.attachments]);
  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const img = target.closest("img");
    if (img && box.current?.contains(img) && (img as HTMLImageElement).src.startsWith("data:")) {
      e.preventDefault();
      return openImageViewer((img as HTMLImageElement).src, img.getAttribute("alt") ?? "");
    }
    const a = target.closest("a");
    if (!a || !box.current?.contains(a)) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href) followLink(href, a.getAttribute("data-issue-key"));
  };
  return <div ref={box} className={`jira-html ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: safe }} />;
}
