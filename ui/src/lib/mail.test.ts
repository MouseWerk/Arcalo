import { describe, expect, it } from "vitest";
import { cleanSubject, dueFor, isMailFile, looksLikeHeaderBlock, mailLinkId, offeredAttachments, preview, priorityFromImportance, senderLabel, type Mail } from "./mail";

const mail = (p: Partial<Mail> = {}): Mail => ({
  source: "outlook",
  entry_id: "A",
  store_id: "S",
  file: "",
  file_name: "",
  subject: "Angebot",
  from_name: "Müller, Anna",
  from_email: "anna@example.com",
  to: [],
  cc: [],
  received: null,
  conversation: "",
  importance: 1,
  categories: [],
  body: "",
  truncated: false,
  attachments: [],
  ...p,
});

describe("mail helpers", () => {
  it("recognizes mail files and links", () => {
    expect(isMailFile("Angebot.eml")).toBe(true);
    expect(isMailFile("RE Budget.MSG")).toBe(true);
    expect(isMailFile("mail.pdf")).toBe(false);
    expect(mailLinkId("annalo-mail://k3v9x2qa")).toBe("k3v9x2qa");
    expect(mailLinkId("annalo-mail://K3V9/")).toBe("k3v9");
    expect(mailLinkId("https://example.com")).toBeNull();
    expect(mailLinkId("annalo-mail://../x")).toBeNull();
  });

  it("detects pasted header blocks in German and English", () => {
    expect(looksLikeHeaderBlock("Von: Anna <a@x.de>\nGesendet: Donnerstag, 24. September 2026 14:32\nAn: Maurice\nBetreff: AW: Angebot")).toBe(true);
    expect(looksLikeHeaderBlock("> **From:** John\n> **Sent:** Thursday, September 24, 2026 2:32 PM\n> **Subject:** RE: Budget")).toBe(true);
    expect(looksLikeHeaderBlock("Von: hier bis dort sind es 5 km")).toBe(false);
    expect(looksLikeHeaderBlock("Betreff: nur das")).toBe(false);
  });

  it("cleans reply prefixes and maps importance", () => {
    expect(cleanSubject("AW: WG: RE: Angebot Portal")).toBe("Angebot Portal");
    expect(cleanSubject("RE[2]: Fwd: Budget")).toBe("Budget");
    expect(cleanSubject("Antw: Rückfrage")).toBe("Rückfrage");
    expect(cleanSubject("Rechnung 42")).toBe("Rechnung 42");
    expect(priorityFromImportance(2)).toBe(2);
    expect(priorityFromImportance(1)).toBe(0);
    expect(priorityFromImportance(0)).toBe(0);
  });

  it("computes the quick due dates", () => {
    const thu = new Date(2026, 8, 24, 10); // Thursday
    expect(dueFor("today", thu)).toBe("2026-09-24");
    expect(dueFor("tomorrow", thu)).toBe("2026-09-25");
    expect(dueFor("friday", thu)).toBe("2026-09-25");
    expect(dueFor("next_week", thu)).toBe("2026-09-28");
    const fri = new Date(2026, 8, 25, 10);
    expect(dueFor("friday", fri)).toBe("2026-09-25");
    const sat = new Date(2026, 8, 26, 10);
    expect(dueFor("friday", sat)).toBe("2026-10-02");
    expect(dueFor("next_week", sat)).toBe("2026-09-28");
    const mon = new Date(2026, 8, 28, 10);
    expect(dueFor("next_week", mon)).toBe("2026-10-05");
    const sun = new Date(2026, 8, 27, 10);
    expect(dueFor("next_week", sun)).toBe("2026-09-28");
  });

  it("labels senders and previews text", () => {
    expect(senderLabel(mail())).toBe("Müller, Anna <anna@example.com>");
    expect(senderLabel(mail({ from_name: "" }))).toBe("anna@example.com");
    expect(senderLabel(mail({ from_name: "a@x.de", from_email: "A@x.de" }))).toBe("a@x.de");
    expect(senderLabel(mail({ from_name: "", from_email: "" }))).toBe("Unbekannter Absender");
    expect(preview("a\r\n\r\n\r\n\r\nb")).toBe("a\n\nb");
    expect(preview("x".repeat(20), 10)).toBe(`${"x".repeat(10)} …`);
    const m = mail({ attachments: [{ index: 1, name: "a.pdf", size: 1, inline: false, file: "" }, { index: 2, name: "logo.png", size: 1, inline: true, file: "" }] });
    expect(offeredAttachments(m, false).map((a) => a.index)).toEqual([1]);
    expect(offeredAttachments(m, true).map((a) => a.index)).toEqual([1, 2]);
  });
});
