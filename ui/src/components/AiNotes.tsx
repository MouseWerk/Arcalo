// Notes every AI surface shares (assistant, inline AI bar, meeting summary, day review): a failed
// request in plain words with what to do, and the empty state when no AI is connected yet.

import { useEffect } from "react";
import { AlertTriangle, RefreshCw, Settings2, Sparkles } from "lucide-react";
import { Button } from "./ui";
import { aiErrorSummary } from "../lib/aierror";
import { openSettingsSection } from "../lib/calnav";
import { t } from "../lib/i18n";
import { usableProvider } from "../lib/providers";
import { useApp } from "../store/app";

/** Opens Settings at „KI & Modelle“, also when the settings tab is open on another section. */
export const openAiSettings = () => openSettingsSection("ai");

/**
 * Whether an AI provider can be asked. When the loaded settings say no, they are read once more
 * (a key stored meanwhile from elsewhere), so the setup note never hides a working provider.
 */
export function useAiConfigured(): boolean {
  const configured = useApp((st) => !st.settings || usableProvider(st.settings));
  useEffect(() => {
    if (!configured) useApp.getState().refreshSettings().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return configured;
}

/** A failed request: the cause in plain words and what to do, „Erneut versuchen“; the server's message under „Details“. */
export function AiErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const e = aiErrorSummary(message);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return (
    <div className="msg-error" role="alert">
      <div className="msg-error-head">
        <AlertTriangle size={14} aria-hidden />
        <span>{e.title}</span>
      </div>
      <div className="msg-error-hint">{offline ? t("chat.offlineHint") : e.hint}</div>
      <details className="msg-error-details">
        <summary>{t("chat.details")}</summary>
        <div className="mono">{message}</div>
      </details>
      {(onRetry || e.settings) && (
        <div className="msg-error-actions">
          {onRetry && (
            <Button size="sm" icon={RefreshCw} onClick={onRetry}>
              {t("chat.retry")}
            </Button>
          )}
          {e.settings && (
            <Button size="sm" variant="ghost" icon={Settings2} onClick={openAiSettings}>
              {t("chat.checkConnection")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** No AI provider can be asked yet: what the feature needs and the way to Settings, instead of a request that must fail. */
export function AiSetupNote({ text }: { text: string }) {
  return (
    <div className="ai-setup-note" role="note">
      <Sparkles size={15} strokeWidth={1.75} aria-hidden className="ai-setup-icon" />
      <div className="ai-setup-text">
        <div className="ai-setup-title">{t("ai.setup.title")}</div>
        <div className="faint small">{text}</div>
      </div>
      <Button size="sm" icon={Settings2} onClick={openAiSettings}>
        {t("ai.setup.action")}
      </Button>
    </div>
  );
}
