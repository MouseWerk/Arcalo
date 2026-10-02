// Workspaces for the graph view (1.9), written as a Markdown folder for `vault_import`:
// a realistic one of about 300 pages (projects, customers, people, meetings, knowledge, Jira
// issue notes, a journal and a few loose notes) in German or English, and a large generated
// one (5,000 pages, about 20,000 links) for the performance check. Deterministic.
import fs from "node:fs";
import path from "node:path";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = {
  de: {
    projects: "Projekte", customersDir: "Kunden", people: "Personen", meetings: "Besprechungen", knowledge: "Wissen", jira: "Jira", journal: "Journal", ideasDir: "Ideen", bookmarksDir: "Lesezeichen",
    sub: ["Anforderungen", "Architektur", "Risiken", "Zeitplan", "Retrospektive"],
    projectNames: ["Kundenportal Relaunch", "Migration S/4HANA", "Mobile App 2.0", "Data Warehouse", "Intranet Neu", "Shop-Integration", "Security Audit", "CRM Einführung"],
    meeting: ["Jour fixe", "Kick-off", "Review", "Workshop", "Statusrunde", "Planung"],
    topics: {
      architektur: ["Microservices", "Event Sourcing", "API-Gateway", "Domain-Driven Design", "Caching-Strategien", "Observability", "Feature Flags", "Datenmodell", "Schnittstellen", "Single Sign-on", "Mandantenfähigkeit", "Lasttests"],
      methoden: ["Scrum", "Kanban", "OKR", "Retrospektiven", "Definition of Done", "Story Points", "Pair Programming", "Code Review", "Onboarding", "Entscheidungsprotokolle", "Risikomanagement"],
      tools: ["Git-Workflow", "CI-Pipeline", "Docker", "Kubernetes", "Terraform", "Grafana", "Jira-Workflows", "Confluence-Migration", "SAP-Schnittstelle", "Testautomatisierung", "Release-Checkliste"],
      recht: ["DSGVO", "Auftragsverarbeitung", "Barrierefreiheit", "Lizenzen", "Aufbewahrungsfristen", "IT-Sicherheitsrichtlinie", "Verträge", "Abnahmeprotokoll", "Gewährleistung", "Datenschutz-Folgenabschätzung", "Löschkonzept"],
    },
    ideas: ["Wissensdatenbank", "Hackathon", "Teamevent", "Newsletter", "Lernpfad", "Vorlagen aufräumen", "Podcast", "Mentoring", "Lean Coffee", "Tech Radar"],
    bookmarks: ["Artikel Architektur", "Video Scrum", "Blog DSGVO", "Paper Caching", "Talk Observability", "Buch DDD", "Kurs Kubernetes", "Checkliste Releases"],
    customers: ["Müller Logistik", "Stadtwerke Nord", "Bäckerei Schmidt", "Hansa Versicherung", "Klinikum Süd", "Alpen Tourismus", "Nordlicht Energie", "Rhein Chemie", "Weber Maschinenbau", "Fischer Medien", "Berg Pharma", "Ostsee Reederei"],
    notes: "Notizen", tasks: "Aufgaben", decision: "Entscheidung", participants: "Teilnehmende", see: "Siehe auch", contact: "Ansprechpartner für", today: "Heute",
  },
  en: {
    projects: "Projects", customersDir: "Customers", people: "People", meetings: "Meetings", knowledge: "Knowledge", jira: "Jira", journal: "Journal", ideasDir: "Ideas", bookmarksDir: "Bookmarks",
    sub: ["Requirements", "Architecture", "Risks", "Schedule", "Retrospective"],
    projectNames: ["Customer Portal Relaunch", "S/4HANA Migration", "Mobile App 2.0", "Data Warehouse", "New Intranet", "Shop Integration", "Security Audit", "CRM Rollout"],
    meeting: ["Weekly sync", "Kick-off", "Review", "Workshop", "Status meeting", "Planning"],
    topics: {
      architecture: ["Microservices", "Event Sourcing", "API Gateway", "Domain-Driven Design", "Caching Strategies", "Observability", "Feature Flags", "Data Model", "Interfaces", "Single Sign-on", "Multi-tenancy", "Load Testing"],
      methods: ["Scrum", "Kanban", "OKR", "Retrospectives", "Definition of Done", "Story Points", "Pair Programming", "Code Review", "Onboarding", "Decision Log", "Risk Management"],
      tools: ["Git Workflow", "CI Pipeline", "Docker", "Kubernetes", "Terraform", "Grafana", "Jira Workflows", "Confluence Migration", "SAP Interface", "Test Automation", "Release Checklist"],
      legal: ["GDPR", "Data Processing Agreement", "Accessibility", "Licenses", "Retention Periods", "IT Security Policy", "Contracts", "Acceptance Report", "Warranty", "Privacy Impact Assessment", "Deletion Concept"],
    },
    ideas: ["Knowledge Base", "Hackathon", "Team Event", "Newsletter", "Learning Path", "Template Cleanup", "Podcast", "Mentoring", "Lean Coffee", "Tech Radar"],
    bookmarks: ["Article Architecture", "Video Scrum", "Blog GDPR", "Paper Caching", "Talk Observability", "Book DDD", "Course Kubernetes", "Release Checklist Links"],
    customers: ["Miller Logistics", "Northern Utilities", "Smith Bakery", "Hansa Insurance", "South Hospital", "Alpine Tourism", "Northern Lights Energy", "Rhine Chemicals", "Weber Engineering", "Fisher Media", "Mountain Pharma", "Baltic Shipping"],
    notes: "Notes", tasks: "Tasks", decision: "Decision", participants: "Participants", see: "See also", contact: "Contact for", today: "Today",
  },
};

const PEOPLE = [
  "Anna Berger", "Jonas Keller", "Lea Hoffmann", "Felix Wagner", "Mia Schulz", "Paul Richter", "Sophie Klein", "Lukas Wolf", "Emma Neumann", "Ben Schwarz", "Hannah Krüger",
  "Noah Braun", "Lina Zimmermann", "Elias Hartmann", "Clara Lange", "Finn Krause", "Marie Werner", "Leon Meier", "Ida Lehmann", "Theo König", "Nora Walter", "Jakob Huber",
  "Lena Kaiser", "Moritz Fuchs", "Greta Peters", "Anton Jung", "Frieda Scholz", "Oskar Möller",
];

function write(dir, folder, title, body, front = {}) {
  const d = path.join(dir, folder);
  fs.mkdirSync(d, { recursive: true });
  const fm = Object.keys(front).length ? `---\n${Object.entries(front).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n` : "";
  fs.writeFileSync(path.join(d, `${title.replace(/[\\/:*?"<>|]/g, "-")}.md`), `${fm}${body}\n`);
}

/**
 * About 300 linked pages below a folder „Arbeit“ („Work“) in `dir`, German or English: each
 * project has a team, a customer and a topic cluster, so the graph shows clusters around the
 * projects joined by shared people and topics. Returns the folder to import.
 */
export function realisticVault(dir, lang = "de") {
  const w = W[lang];
  const root = path.join(dir, lang === "de" ? "Arbeit" : "Work");
  dir = root;
  const r = rng(lang === "de" ? 1903 : 1904);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const some = (list, n) => [...new Set(Array.from({ length: n }, () => pick(list)))];
  const projects = w.projectNames;
  const topicGroups = Object.entries(w.topics);
  const topics = topicGroups.flatMap(([, l]) => l);
  const meetings = [];
  const team = (i) => [0, 1, 2, 3].map((k) => PEOPLE[(i * 3 + k) % PEOPLE.length]);
  const cluster = (i) => {
    const l = topicGroups[i % topicGroups.length][1];
    const o = Math.floor(i / topicGroups.length) * 4;
    return [0, 1, 2, 3, 4].map((k) => l[(o + k) % l.length]);
  };
  const customerOf = (i) => w.customers[i % w.customers.length];

  projects.forEach((p, i) => {
    const subs = w.sub.map((s) => `${p} – ${s}`);
    const [lead] = team(i);
    write(dir, w.projects, p, `# ${p}\n\n${w.contact} [[${customerOf(i)}]]: [[${lead}]].\n\n${subs.map((s) => `- [[${s}]]`).join("\n")}\n\n${w.see}: ${cluster(i).slice(0, 2).map((x) => `[[${x}]]`).join(", ")}\n\n#projekt`, { netzplan: `NP-${4700 + i * 11}` });
    subs.forEach((s, k) => write(dir, `${w.projects}/${p}`, s, `[[${p}]]\n\n- [[${team(i)[k % 4]}]]\n- [[${cluster(i)[k % 5]}]]\n`));
  });
  w.customers.forEach((c, i) => {
    const ps = projects.filter((_, j) => customerOf(j) === c);
    write(dir, w.customersDir, c, `# ${c}\n\n${ps.map((p) => `- [[${p}]]`).join("\n")}\n- [[${PEOPLE[(i * 5 + 1) % PEOPLE.length]}]]\n\n#kunde`);
  });
  PEOPLE.forEach((p, i) => {
    const j = Math.floor(i / 3) % projects.length;
    write(dir, w.people, p, `[[${projects[j]}]]${r() < 0.3 ? ` · [[${customerOf(j)}]]` : ""}\n\n#person`);
  });
  for (const [group, list] of topicGroups) {
    list.forEach((t, i) => {
      const near = [list[(i + 1) % list.length], ...(r() < 0.15 ? [pick(topics)] : [])];
      write(dir, `${w.knowledge}/${group[0].toUpperCase()}${group.slice(1)}`, t, `# ${t}\n\n${w.see}: ${near.map((x) => `[[${x}]]`).join(", ")}${r() < 0.2 ? ` [[${lang === "de" ? "Glossar" : "Glossary"}]]` : ""}\n\n#wissen/${group}`);
    });
  }
  for (let i = 0; i < 72; i++) {
    const pi = Math.floor(Math.pow(r(), 1.4) * projects.length);
    const p = projects[pi];
    const day = String(1 + (i % 28)).padStart(2, "0");
    const month = i < 36 ? "08" : "09";
    const title = `2026-${month}-${day} ${pick(w.meeting)} ${p.split(" ")[0]}${i % 3 ? "" : ` ${i}`}`;
    if (meetings.includes(title)) continue;
    meetings.push(title);
    const people = some(team(pi), 2 + Math.floor(r() * 2));
    write(dir, `${w.meetings}/2026-${month}`, title, `${w.participants}: ${people.map((x) => `[[${x}]]`).join(", ")}\n\n## ${w.notes}\n[[${p}]]${r() < 0.3 ? ` · [[${customerOf(pi)}]]` : ""}${r() < 0.3 ? ` · [[${pick(cluster(pi))}]]` : ""}\n\n## ${w.decision}\n- ${pick(w.sub)}\n\n#besprechung`);
  }
  projects.slice(0, 5).forEach((p, pi) => {
    const key = ["KP", "SAP", "APP", "DWH", "INT"][pi];
    for (let n = 1; n <= 4; n++) write(dir, `${w.jira}/${key}`, `${key}-${100 + n * 7} ${pick(w.sub)}`, `[[${p}]] · [[${pick(team(pi))}]]`, { jira: `${key}-${100 + n * 7}` });
  });
  for (let i = 0; i < 36; i++) {
    const m = pick(meetings);
    const p = projects.find((x) => m.includes(x.split(" ")[0])) ?? pick(projects);
    write(dir, `${w.journal}/2026`, `${w.journal} 2026-09-${String(1 + (i % 30)).padStart(2, "0")}${i >= 30 ? "b" : ""}`, `${w.today}: [[${m}]], [[${p}]]\n\n#journal`);
  }
  w.ideas.forEach((t, i) => write(dir, w.ideasDir, t, i % 3 === 0 ? `${t}.` : `[[${pick(topics)}]]${i % 4 === 1 ? ` [[${lang === "de" ? "Wunschliste" : "Wish list"}]]` : ""}\n\n#idee`));
  w.bookmarks.forEach((t) => write(dir, w.bookmarksDir, t, `https://example.org/${encodeURIComponent(t)}`));
  return root;
}

/** `count` pages in 25 folders with about four links each (local, to hubs and random). */
export function largeVault(dir, count = 5000, lang = "de") {
  const r = rng(77);
  dir = path.join(dir, lang === "de" ? "Archiv" : "Archive");
  const area = lang === "de" ? "Bereich" : "Area";
  const note = lang === "de" ? "Notiz" : "Note";
  const title = (i) => `${note} ${String(i).padStart(4, "0")}`;
  const per = Math.ceil(count / 25);
  let links = 0;
  for (let i = 0; i < count; i++) {
    const f = Math.floor(i / per);
    const base = f * per;
    const targets = new Set();
    targets.add(base + Math.floor(r() * per));
    targets.add(base + Math.floor(r() * per));
    targets.add(Math.floor(Math.pow(r(), 3) * count));
    targets.add(Math.floor(r() * count));
    targets.delete(i);
    const valid = [...targets].filter((t) => t < count);
    links += valid.length;
    write(dir, `${area} ${String(f + 1).padStart(2, "0")}`, title(i), `${valid.map((t) => `[[${title(t)}]]`).join(" ")}\n\n#t${i % 10}`);
  }
  return { root: dir, pages: count, links };
}
