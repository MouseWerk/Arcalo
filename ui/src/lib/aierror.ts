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

/** Reads a German `errorText` of a failed AI request (`KI-Server meldet Fehler 500: {…}`, `Verbindungsfehler: …`). */
export function aiErrorSummary(message: string): AiErrorSummary {
  const m = message.toLowerCase();
  const status = Number(/Fehler (\d{3})/.exec(message)?.[1] ?? /\b"?code"?\s*:\s*"?(\d{3})/.exec(message)?.[1] ?? 0);
  if (/zeitüberschreitung|timed? ?out|timeout/.test(m))
    return { title: "Das Modell hat nicht rechtzeitig geantwortet.", hint: "Später erneut versuchen oder ein schnelleres Modell wählen.", settings: false };
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|authentication/.test(m))
    return { title: "Der KI-Server hat den Zugang abgelehnt.", hint: "API-Token in den KI-Einstellungen prüfen.", settings: true };
  // LiteLLM pauses a model for a few seconds after failed requests (cooldown).
  const again = Number(/try again in (\d+) seconds?/.exec(m)?.[1] ?? NaN);
  if (/no deployments available/.test(m) && (again <= 10 || (/cooldown_list/.test(m) && !(again > 10))))
    return {
      title: "Der KI-Server pausiert das Modell kurz nach einem Fehler.",
      hint: "In ein paar Sekunden erneut versuchen. Passiert das oft, das Embedding-Modell in den KI-Einstellungen prüfen.",
      settings: false,
    };
  if (/no deployments available/.test(m))
    return { title: "Für dieses Modell ist gerade kein Server verfügbar.", hint: "In einer Minute erneut versuchen oder ein anderes Modell wählen.", settings: false };
  if (/kein embedding-modell|liefert keine embeddings/.test(m) || (/embedding/.test(m) && (status === 404 || status === 400 || /not found|not support/.test(m))))
    return { title: "Das Modell kann keine Embeddings berechnen.", hint: "Unter Einstellungen → KI ein Embedding-Modell wählen oder „Keine (nur Stichwortsuche)“.", settings: true };
  if (/does not support parameters: \['tools'\]|unsupportedparams|enable-auto-tool-choice|tool-call-parser/.test(m))
    return { title: "Das Modell kann keine Werkzeuge nutzen.", hint: "Werkzeuge im Modellmenü abschalten oder ein anderes Modell wählen.", settings: false };
  if (status === 429 || /rate.?limit|budget/.test(m))
    return { title: "Zu viele Anfragen oder Budget aufgebraucht.", hint: "Kurz warten und erneut versuchen.", settings: false };
  if (/context.?length|too many tokens|maximum context/.test(m))
    return { title: "Die Anfrage ist zu lang für das Modell.", hint: "Weniger Kontext anhängen oder einen neuen Chat beginnen.", settings: false };
  if (status === 404 || /model.*not found|does not exist|gibt es auf dem \S*-server nicht|gibt es bei .* nicht/.test(m))
    return { title: "Das Modell gibt es auf dem KI-Server nicht.", hint: "Modellzuordnung in den KI-Einstellungen prüfen.", settings: true };
  if (status >= 500 && /connection ?(refused|error)|apiconnectionerror|unreachable|errno 111/.test(m))
    return { title: "Der KI-Server erreicht das Modell nicht.", hint: "Läuft der Modelldienst (z. B. Ollama)? Sonst die Administration fragen.", settings: false };
  if (/zertifikat|certificate/.test(m))
    return { title: "Das Zertifikat des KI-Servers wird nicht anerkannt.", hint: "Das Firmenzertifikat unter Einstellungen → Netzwerk hinterlegen.", settings: true };
  if (/proxy/.test(m)) return { title: "Der Proxy ist nicht erreichbar.", hint: "Proxy-Einstellungen unter Einstellungen → Netzwerk prüfen.", settings: true };
  if (/netzwerkeinstellungen ungültig/.test(m)) return { title: "Die Netzwerkeinstellungen sind ungültig.", hint: "Einstellungen → Netzwerk prüfen.", settings: true };
  if (/brach während der antwort ab|antwort unvollständig/.test(m))
    return { title: "Die Antwort wurde unterbrochen.", hint: "Erneut versuchen.", settings: false };
  if (/leere antwort|keine antwort im erwarteten format/.test(m))
    return { title: "Der KI-Server hat keine verwertbare Antwort geliefert.", hint: "Erneut versuchen; bleibt es so, Server-URL und Anmeldung (z. B. WLAN-Portal) prüfen.", settings: true };
  if (/^verbindungsfehler|connection refused|error sending request|dns|connect|nicht erreichbar/.test(m))
    return { title: "Der KI-Server ist nicht erreichbar.", hint: "Server-URL und Netzwerk in den Einstellungen prüfen.", settings: true };
  if (status >= 500) return { title: "Der KI-Server meldet einen internen Fehler.", hint: "Später erneut versuchen.", settings: false };
  return { title: "Die Anfrage ist fehlgeschlagen.", hint: "Erneut versuchen oder die Verbindung prüfen.", settings: true };
}

/**
 * The route notes an answer shows visibly (not only in the tooltip): another model answered,
 * a model without tools, a wait for the server, a search without embeddings. They are the
 * German reasons with an arrow or the fallback warning; the router's own scoring stays hidden.
 */
export function routeNotes(reasons: string[]): string[] {
  return reasons.filter((r) => r.includes("→") || r.startsWith("Ausweichmodell"));
}

/** Status line while the server pauses the model: „Server kurz ausgelastet, neuer Versuch in 5 s“. */
export function waitText(secondsLeft: number): string {
  const s = Math.ceil(secondsLeft);
  return s > 0 ? `Server kurz ausgelastet, neuer Versuch in ${s} s` : "Server kurz ausgelastet, neuer Versuch läuft …";
}
