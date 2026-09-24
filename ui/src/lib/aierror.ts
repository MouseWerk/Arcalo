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
  if (/no deployments available/.test(m))
    return { title: "Für dieses Modell ist gerade kein Server verfügbar.", hint: "In einer Minute erneut versuchen oder ein anderes Modell wählen.", settings: false };
  if (/does not support parameters: \['tools'\]|unsupportedparams/.test(m))
    return { title: "Das Modell kann keine Werkzeuge nutzen.", hint: "Werkzeuge im Modellmenü abschalten oder ein anderes Modell wählen.", settings: false };
  if (status === 429 || /rate.?limit|budget/.test(m))
    return { title: "Zu viele Anfragen oder Budget aufgebraucht.", hint: "Kurz warten und erneut versuchen.", settings: false };
  if (/context.?length|too many tokens|maximum context/.test(m))
    return { title: "Die Anfrage ist zu lang für das Modell.", hint: "Weniger Kontext anhängen oder einen neuen Chat beginnen.", settings: false };
  if (status === 404 || /model.*not found|does not exist|gibt es auf dem litellm-server nicht/.test(m))
    return { title: "Das Modell gibt es auf dem KI-Server nicht.", hint: "Modellzuordnung in den KI-Einstellungen prüfen.", settings: true };
  if (status >= 500 && /connection ?(refused|error)|apiconnectionerror|unreachable|errno 111/.test(m))
    return { title: "Der KI-Server erreicht das Modell nicht.", hint: "Läuft der Modelldienst (z. B. Ollama)? Sonst die Administration fragen.", settings: false };
  if (/^verbindungsfehler|connection refused|error sending request|dns|connect/.test(m))
    return { title: "Der KI-Server ist nicht erreichbar.", hint: "Server-URL und Netzwerk in den Einstellungen prüfen.", settings: true };
  if (status >= 500) return { title: "Der KI-Server meldet einen internen Fehler.", hint: "Später erneut versuchen.", settings: false };
  return { title: "Die Anfrage ist fehlgeschlagen.", hint: "Erneut versuchen oder die Verbindung prüfen.", settings: true };
}
