import { describe, expect, it, vi } from "vitest";

// happy-dom's DOM makes DOMPurify keep scripts and drop the first element; the browser's does not.
// The view's own allowlist pass is what these tests check.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
import { canDeleteComment, canEditComment, editable, fmtSeconds, jiraDate, ordered, parseIssueKey, sanitizeJiraHtml, timeBar, useIssueModal, type IssueFull, type JComment, type Perms } from "./issueFull";

describe("issue keys", () => {
  it("reads keys and Jira addresses", () => {
    expect(parseIssueKey("PROJ-12")).toBe("PROJ-12");
    expect(parseIssueKey(" proj-12 ")).toBe("PROJ-12");
    expect(parseIssueKey("https://acme.atlassian.net/browse/OPS-7")).toBe("OPS-7");
    expect(parseIssueKey("https://jira.firma.de/jira/browse/ERP-7?focusedCommentId=1")).toBe("ERP-7");
    expect(parseIssueKey("PROJ-0")).toBeNull();
    expect(parseIssueKey("A-1")).toBeNull();
    expect(parseIssueKey("login fails")).toBeNull();
  });

  it("stacks the issues opened from the view and goes back", () => {
    const m = useIssueModal.getState();
    m.open("PROJ-1");
    m.open("PROJ-1");
    m.open("PROJ-2");
    expect(useIssueModal.getState().stack).toEqual(["PROJ-1", "PROJ-2"]);
    useIssueModal.getState().back();
    expect(useIssueModal.getState().stack).toEqual(["PROJ-1"]);
    useIssueModal.getState().close();
    expect(useIssueModal.getState().stack).toEqual([]);
  });
});

describe("Jira's timestamps and durations", () => {
  it("reads offsets without a colon (WebKit does not)", () => {
    expect(jiraDate("2026-10-20T11:22:33.123+0200")?.toISOString()).toBe("2026-10-20T09:22:33.123Z");
    expect(jiraDate("2026-10-20T09:22:33Z")?.toISOString()).toBe("2026-10-20T09:22:33.000Z");
    expect(jiraDate("")).toBeNull();
    expect(jiraDate("nonsense")).toBeNull();
  });

  it("words seconds like Jira (8 h days, 5 day weeks)", () => {
    expect(fmtSeconds(5400)).toBe("1h 30m");
    expect(fmtSeconds(57600)).toBe("2d");
    expect(fmtSeconds(144000 + 3600)).toBe("1w 1h");
    expect(fmtSeconds(0)).toBe("0m");
    expect(fmtSeconds(null)).toBe("0m");
  });

  it("draws the time tracking bar", () => {
    const tt = (original: number | null, remaining: number | null, spent: number | null) => ({ original, remaining, spent, original_text: "", remaining_text: "", spent_text: "" });
    expect(timeBar(tt(57600, 43200, 14400))).toEqual({ logged: 0.25, remaining: 0.75, over: false });
    expect(timeBar(tt(3600, 3600, 3600))).toEqual({ logged: 0.5, remaining: 0.5, over: true });
    expect(timeBar(tt(7200, null, 3600))).toEqual({ logged: 0.5, remaining: 0.5, over: false });
    expect(timeBar(tt(null, null, null))).toBeNull();
  });
});

describe("Jira's HTML", () => {
  const base = "https://acme.atlassian.net";
  it("keeps the content and drops scripts, styles and handlers", () => {
    const html = sanitizeJiraHtml('<h2 style="color:red">Steps</h2><p onclick="x()">Open <b>it</b><script>alert(1)</script></p><div class="panel" style="background:#fff"><p>Note</p></div>', base);
    expect(html).toContain("<h2>Steps</h2>");
    expect(html).toContain("<b>it</b>");
    expect(html).toContain('class="j-panel"');
    expect(html).not.toMatch(/script|onclick|style=/);
  });

  it("loads images through the site's client and shows emoticons as text", () => {
    const html = sanitizeJiraHtml('<img src="/rest/api/3/attachment/content/10500" alt="shot.png"><img class="emoticon" src="/images/icons/emoticons/smile.png" alt=":)"><img src="javascript:alert(1)">', base);
    expect(html).toContain('data-jira-src="https://acme.atlassian.net/rest/api/3/attachment/content/10500"');
    expect(html).not.toMatch(/\ssrc=/);
    expect(html).toContain(":)");
    expect(html).not.toContain("emoticons");
  });

  it("makes links absolute, marks issue links and drops unsafe ones", () => {
    const html = sanitizeJiraHtml('<a href="/browse/PROJ-7">PROJ-7</a> <a href="https://other.example/x">x</a> <a href="javascript:alert(1)">bad</a> <a href="/secure/ViewProfile.jspa?accountId=1">Tom</a>', base);
    expect(html).toContain('href="https://acme.atlassian.net/browse/PROJ-7" data-issue-key="PROJ-7"');
    expect(html).toContain('href="https://other.example/x"');
    expect(html).not.toContain("javascript");
    expect(html).toContain('href="https://acme.atlassian.net/secure/ViewProfile.jspa?accountId=1"');
  });
});

describe("permissions", () => {
  const perms = (p: Partial<Perms>): Perms => ({ comment: true, edit_own_comments: false, edit_all_comments: false, delete_own_comments: false, delete_all_comments: false, log_work: true, assign: true, assignable: true, transition: true, ...p });
  const comment = (own: boolean) => ({ id: "1", own }) as JComment;
  it("lets edit and delete own comments, others' only with the permission for all", () => {
    expect(canEditComment(perms({ edit_own_comments: true }), comment(true))).toBe(true);
    expect(canEditComment(perms({ edit_own_comments: true }), comment(false))).toBe(false);
    expect(canEditComment(perms({ edit_all_comments: true }), comment(false))).toBe(true);
    expect(canDeleteComment(perms({ delete_own_comments: true }), comment(true))).toBe(true);
    expect(canDeleteComment(perms({}), comment(true))).toBe(false);
  });

  it("offers editing only where editmeta allows it", () => {
    const issue = {
      edit: [
        { id: "summary", operations: ["set"], kind: "text" },
        { id: "customfield_10020", operations: ["set"], kind: "unsupported" },
        { id: "labels", operations: ["add", "remove"], kind: "labels" },
        { id: "watch", operations: [], kind: "text" },
      ],
    } as unknown as IssueFull;
    expect(editable(issue, "summary")?.id).toBe("summary");
    expect(editable(issue, "labels")?.id).toBe("labels");
    expect(editable(issue, "customfield_10020")).toBeNull();
    expect(editable(issue, "watch")).toBeNull();
    expect(editable(issue, "reporter")).toBeNull();
  });

  it("orders comments as chosen", () => {
    expect(ordered([3, 2, 1], true)).toEqual([3, 2, 1]);
    expect(ordered([3, 2, 1], false)).toEqual([1, 2, 3]);
  });
});
