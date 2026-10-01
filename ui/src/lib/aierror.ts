import { t } from "./i18n";
// Failed assistant requests in plain words: a one-line cause and what to do, the raw
// server message stays available as details.

export interface AiErrorSummary {
  /** What went wrong, in a few words. */
  title: string;
  /** What the user can do about it. */
  hint: string;
  /** Whether the connection settings are the likely fix (shows „Verbindung prüfen“). */
  settings: boolean;
}

/**
 * Reads the `errorText` of a failed AI request, in German or English (`KI-Server meldet Fehler
 * 500: {…}` / `AI server reported error 500: {…}`, `Verbindungsfehler: …` / `Connection error: …`).
 */
export function aiErrorSummary(message: string): AiErrorSummary {
  const m = message.toLowerCase();
  const out = (key: "timeout" | "denied" | "cooldown" | "noServer" | "noEmbeddings" | "noTools" | "rateLimit" | "tooLong" | "noModel" | "modelDown" | "certificate" | "proxy" | "network" | "interrupted" | "empty" | "unreachable" | "internal" | "failed", settings: boolean): AiErrorSummary => ({
    title: t(`ai.err.${key}` as const),
    hint: t(`ai.err.${key}Hint` as const),
    settings,
  });
  const status = Number(/(?:Fehler|error) (\d{3})/.exec(message)?.[1] ?? /\b"?code"?\s*:\s*"?(\d{3})/.exec(message)?.[1] ?? 0);
  if (/zeitüberschreitung|timed? ?out|timeout/.test(m)) return out("timeout", false);
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|authentication/.test(m)) return out("denied", true);
  // LiteLLM pauses a model for a few seconds after failed requests (cooldown).
  const again = Number(/try again in (\d+) seconds?/.exec(m)?.[1] ?? NaN);
  if (/no deployments available/.test(m) && (again <= 10 || (/cooldown_list/.test(m) && !(again > 10)))) return out("cooldown", false);
  if (/no deployments available/.test(m)) return out("noServer", false);
  if (/kein embedding-modell|liefert keine embeddings|no embedding model|returns no embeddings/.test(m) || (/embedding/.test(m) && (status === 404 || status === 400 || /not found|not support/.test(m))))
    return out("noEmbeddings", true);
  if (/does not support parameters: \['tools'\]|unsupportedparams|enable-auto-tool-choice|tool-call-parser/.test(m)) return out("noTools", false);
  if (status === 429 || /rate.?limit|budget/.test(m)) return out("rateLimit", false);
  if (/context.?length|too many tokens|maximum context/.test(m)) return out("tooLong", false);
  if (status === 404 || /model.*not found|does not exist|gibt es auf dem \S*-server nicht|gibt es bei .* nicht/.test(m)) return out("noModel", true);
  if (status >= 500 && /connection ?(refused|error)|apiconnectionerror|unreachable|errno 111/.test(m)) return out("modelDown", false);
  if (/zertifikat|certificate/.test(m)) return out("certificate", true);
  if (/proxy/.test(m)) return out("proxy", true);
  if (/netzwerkeinstellungen ungültig|network settings are invalid/.test(m)) return out("network", true);
  if (/brach während der antwort ab|antwort unvollständig|broke off during the answer|answer incomplete/.test(m)) return out("interrupted", false);
  if (/leere antwort|keine antwort im erwarteten format|empty answer|no answer in the expected format/.test(m)) return out("empty", true);
  if (/^verbindungsfehler|^connection error|connection refused|error sending request|dns|connect|nicht erreichbar/.test(m)) return out("unreachable", true);
  if (status >= 500) return out("internal", false);
  return out("failed", true);
}

/**
 * The route notes an answer shows visibly (not only in the tooltip): another model answered,
 * a model without tools, a wait for the server, a search without embeddings. They are the
 * reasons with an arrow or the fallback warning (in either language); the router's own scoring
 * stays hidden.
 */
export function routeNotes(reasons: string[]): string[] {
  return reasons.filter((r) => r.includes("→") || r.startsWith("Ausweichmodell") || r.startsWith("Fallback model"));
}

/** Status line while the server pauses the model: „Server kurz ausgelastet, neuer Versuch in 5 s“. */
export function waitText(secondsLeft: number): string {
  const s = Math.ceil(secondsLeft);
  return s > 0 ? t("ai.wait", { s }) : t("ai.waitNow");
}
