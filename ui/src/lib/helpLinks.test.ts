import { describe, expect, it } from "vitest";
import { DOC_PAGES, ISSUES_URL, SITE_URL, docsUrl, issueUrl, type HelpTopic } from "./helpLinks";

describe("documentation links", () => {
  it("follow the UI language", () => {
    expect(docsUrl("home", "en")).toBe("https://arcalo.mousewerk.de/docs/");
    expect(docsUrl("home", "de")).toBe("https://arcalo.mousewerk.de/de/docs/");
    expect(docsUrl("shortcuts", "en")).toBe("https://arcalo.mousewerk.de/docs/workspace/shortcuts/");
    expect(docsUrl("shortcuts", "de")).toBe("https://arcalo.mousewerk.de/de/docs/workspace/shortcuts/");
    expect(docsUrl("gitSync", "de")).toBe("https://arcalo.mousewerk.de/de/docs/data/git-sync/");
  });

  it("name every page as section/page below the one site", () => {
    expect(SITE_URL).toMatch(/^https:\/\/[^/]+$/);
    for (const [topic, page] of Object.entries(DOC_PAGES)) {
      if (topic === "home") expect(page).toBe("");
      else expect(page, topic).toMatch(/^[a-z]+(-[a-z]+)*\/[a-z]+(-[a-z]+)*$/);
      for (const lang of ["de", "en"] as const) {
        const url = docsUrl(topic as HelpTopic, lang);
        expect(url.startsWith(SITE_URL)).toBe(true);
        expect(url.endsWith("/")).toBe(true);
        expect(url).not.toContain("//docs");
        expect(new URL(url).pathname).not.toContain("//");
      }
    }
  });
});

describe("issue forms", () => {
  it("open the form with only the version and the system filled in", () => {
    expect(issueUrl("feedback", { version: "1.14.0", os: "Windows 11 24H2" })).toBe(
      "https://github.com/MouseWerk/Arcalo/issues/new?template=feedback.yml&version=1.14.0&os=Windows%2011%2024H2",
    );
    const bug = new URL(issueUrl("bug", { version: "1.14.0", os: "macOS 15.1" }));
    expect(`${bug.origin}${bug.pathname}`).toBe(ISSUES_URL);
    expect([...bug.searchParams.keys()]).toEqual(["template", "version", "os"]);
    expect(bug.searchParams.get("template")).toBe("bug_report.yml");
    expect(bug.searchParams.get("os")).toBe("macOS 15.1");
  });

  it("leave out what is unknown and encode the rest", () => {
    expect(issueUrl("bug", { version: "", os: " " })).toBe(`${ISSUES_URL}?template=bug_report.yml`);
    const u = new URL(issueUrl("feedback", { version: "1.14.0-beta+1", os: "Fedora Linux 41 (Workstation Edition) & more" }));
    expect(u.searchParams.get("version")).toBe("1.14.0-beta+1");
    expect(u.searchParams.get("os")).toBe("Fedora Linux 41 (Workstation Edition) & more");
  });
});
