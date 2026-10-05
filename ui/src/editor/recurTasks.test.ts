import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { undo } from "@tiptap/pm/history";
import { buildExtensions, toMarkdown } from "./schema";

const editorFor = (md: string, nextDue: (text: string) => Promise<string | null>) =>
  new Editor({ element: document.createElement("div"), extensions: buildExtensions({ taskNextDue: nextDue }), content: md, contentType: "markdown" });

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
});
