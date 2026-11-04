import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { undo } from "@tiptap/pm/history";
import { buildExtensions, toMarkdown } from "./schema";

/** An editor whose core answers the due date `nextDue` gives (and, for `rules`, the rule to write). */
const editorFor = (md: string, nextDue: (text: string) => Promise<string | null>, rules: Record<string, [string, string]> = {}) =>
  new Editor({
    element: document.createElement("div"),
    extensions: buildExtensions({
      taskNext: async (text) => {
        const due = await nextDue(text);
        const rule = Object.entries(rules).find(([k]) => text.startsWith(k))?.[1];
        return due ? { due, rule_from: rule?.[0] ?? null, rule_to: rule?.[1] ?? null } : null;
      },
    }),
    content: md,
    contentType: "markdown",
  });

/** Ticks the `n`th task item like a click on its box (TaskItem's node view uses setNodeMarkup). */
function tick(e: Editor, n: number, checked = true) {
  let at = -1;
  let seen = 0;
  e.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.type.name === "taskItem" && seen++ === n) at = pos;
    return true;
  });
  const node = e.state.doc.nodeAt(at)!;
  e.view.dispatch(e.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, checked }));
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("repeating tasks in the editor", () => {
  it("adds the next occurrence below the subtasks; one undo takes both back", async () => {
    const asked: string[] = [];
    const e = editorFor("- [ ] Müll every:weekly due:2026-10-05 ^abc\n  - [ ] Tonne raus\n- [ ] Anderes", async (text) => (asked.push(text), "2026-10-12"));
    tick(e, 0);
    await settle();
    expect(asked).toEqual(["Müll every:weekly due:2026-10-05 ^abc"]);
    expect(toMarkdown(e)).toBe("- [x] Müll every:weekly due:2026-10-05 ^abc\n  - [ ] Tonne raus\n- [ ] Müll every:weekly due:2026-10-12\n- [ ] Anderes\n");
    undo(e.state, e.view.dispatch);
    expect(toMarkdown(e)).toBe("- [ ] Müll every:weekly due:2026-10-05 ^abc\n  - [ ] Tonne raus\n- [ ] Anderes\n");
    e.destroy();
  });

  it("adds a due date when the task had none; plain tasks, unticking and undo ask nothing", async () => {
    const asked: string[] = [];
    const e = editorFor("- [ ] Gießen every:3d,done\n- [ ] Einmal\n- [x] Fertig every:daily", async (text) => (asked.push(text), text.startsWith("Gießen") ? "2026-10-08" : null));
    tick(e, 0);
    await settle();
    expect(toMarkdown(e)).toBe("- [x] Gießen every:3d,done\n- [ ] Gießen every:3d,done due:2026-10-08\n- [ ] Einmal\n- [x] Fertig every:daily\n");
    tick(e, 2);
    tick(e, 3, false);
    undo(e.state, e.view.dispatch);
    await settle();
    expect(asked).toEqual(["Gießen every:3d,done"]);
    e.destroy();
  });

  it("writes the rule the core gives, so a monthly task from the 31st keeps its day", async () => {
    const e = editorFor("- [ ] **Miete** zahlen every:monthly until:2026-12-31 due:2026-01-31", async () => "2026-02-28", { "Miete zahlen": ["every:monthly", "every:monthly,31"] });
    tick(e, 0);
    await settle();
    expect(toMarkdown(e)).toBe("- [x] **Miete** zahlen every:monthly until:2026-12-31 due:2026-01-31\n- [ ] **Miete** zahlen every:monthly,31 until:2026-12-31 due:2026-02-28\n");
    e.destroy();
  });
});
