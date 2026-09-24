import { describe, expect, it } from "vitest";
import { aiErrorSummary } from "./aierror";
import { errorText } from "./api";

describe("aiErrorSummary", () => {
  it("names a model backend the proxy cannot reach", () => {
    const e = 'KI-Server meldet Fehler 500: {"error":{"message":"litellm.APIConnectionError: OllamaException - [Errno 111] Connection refused","code":"500"}}';
    expect(aiErrorSummary(e)).toMatchObject({ title: "Der KI-Server erreicht das Modell nicht.", settings: false });
  });
  it("sends connection and token problems to the settings", () => {
    expect(aiErrorSummary("Verbindungsfehler: error sending request for url (http://127.0.0.1:4000/)")).toMatchObject({ title: "Der KI-Server ist nicht erreichbar.", settings: true });
    expect(aiErrorSummary('KI-Server meldet Fehler 401: {"error":"Unauthorized"}').settings).toBe(true);
    expect(aiErrorSummary("KI-Server meldet Fehler 404: model not found").title).toBe("Das Modell gibt es auf dem KI-Server nicht.");
    expect(aiErrorSummary("Das lokale Modell „llama3.2“ gibt es auf dem Ollama-Server nicht. Vertrauliche Inhalte bleiben lokal").settings).toBe(true);
  });
  it("recognizes timeouts, limits and long requests", () => {
    expect(aiErrorSummary("KI-Server meldet Fehler 0: Keine Antwort vom Modell (Zeitüberschreitung)").title).toMatch(/nicht rechtzeitig/);
    expect(aiErrorSummary("KI-Server meldet Fehler 429: rate limit").title).toMatch(/Zu viele/);
    expect(aiErrorSummary('KI-Server meldet Fehler 429: {"error":{"message":"No deployments available for selected model, Try again in 60 seconds."}}').title).toMatch(/kein Server verfügbar/);
    expect(aiErrorSummary("KI-Server meldet Fehler 400: litellm.UnsupportedParamsError: m does not support parameters: ['tools']").title).toMatch(/Werkzeuge/);
    expect(aiErrorSummary("KI-Server meldet Fehler 400: maximum context length is 8192 tokens").title).toMatch(/zu lang/);
  });
  it("falls back to a general message", () => {
    expect(aiErrorSummary("irgendwas").title).toBe("Die Anfrage ist fehlgeschlagen.");
    expect(aiErrorSummary("KI-Server meldet Fehler 502: Bad Gateway").title).toBe("Der KI-Server meldet einen internen Fehler.");
  });
  it("tells proxy, certificate and broken answers apart from an unreachable server", () => {
    expect(aiErrorSummary("Verbindungsfehler: Proxy nicht erreichbar oder er lehnt die Verbindung ab (error sending request: …)").title).toBe("Der Proxy ist nicht erreichbar.");
    expect(aiErrorSummary("Verbindungsfehler: Das Zertifikat des Servers wird nicht anerkannt (invalid peer certificate: UnknownIssuer)").title).toMatch(/Zertifikat/);
    expect(aiErrorSummary("Verbindungsfehler: Die Verbindung brach während der Antwort ab (error decoding response body)").title).toBe("Die Antwort wurde unterbrochen.");
    expect(aiErrorSummary("Leere Antwort des KI-Servers").settings).toBe(true);
  });
});

describe("errorText", () => {
  it("drops repeated technical prefixes", () => {
    expect(errorText("invalid state: invalid state: Kein Netz")).toBe("Kein Netz");
    expect(errorText("Dateifehler: Der Datenträger ist voll")).toBe("Dateifehler: Der Datenträger ist voll");
  });
});
