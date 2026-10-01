import { describe, expect, it } from "vitest";
import { parseTasks } from "./tasks.js";

describe("parseTasks", () => {
  it("reads status, dates, priority, and recurrence in Obsidian Tasks format", () => {
    const content = [
      "---", "id: p", "---", "",
      "- [ ] Draft pricing page 📅 2026-10-04 ⏫",
      "- [/] Interview users 🔼 ⏳ 2026-10-02 🛫 2026-10-01",
      "- [x] Ship beta ✅ 2026-09-29",
      "- [-] Old idea",
      "* [ ] Weekly invoice 🔁 every week 📅 2026-10-06",
      "  - [ ] Nested step ⏬",
      "- [ ] Variation selector ⏳️ 2026-10-03"
    ].join("\n");
    expect(parseTasks(content)).toEqual([
      { line: 5, text: "Draft pricing page", status: "open", due: "2026-10-04", priority: "high" },
      { line: 6, text: "Interview users", status: "in-progress", scheduled: "2026-10-02", start: "2026-10-01", priority: "medium" },
      { line: 7, text: "Ship beta", status: "done", done: "2026-09-29" },
      { line: 8, text: "Old idea", status: "cancelled" },
      { line: 9, text: "Weekly invoice", status: "open", due: "2026-10-06", recurrence: "every week" },
      { line: 10, text: "Nested step", status: "open", priority: "lowest" },
      { line: 11, text: "Variation selector", status: "open", scheduled: "2026-10-03" }
    ]);
  });

  it("ignores frontmatter, fenced code, and plain list items", () => {
    const content = ["---", "tasks: \"- [ ] not a task\"", "---", "```md", "- [ ] example only", "```", "- plain item", "- [ ] real"].join("\n");
    expect(parseTasks(content).map((task) => task.text)).toEqual(["real"]);
  });
});
