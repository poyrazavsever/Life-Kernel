import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readFrontmatter, setFrontmatter } from "./frontmatter.js";

const note = ["---", 'id: "d1"', "# kept comment", 'status: "proposed"', 'decided_on: ""', "tags:", "  - a", "---", "", "# Decision", "", "Body stays."].join("\n");

describe("readFrontmatter", () => {
  it("parses YAML, including CRLF and a BOM, and rejects what is not a mapping", () => {
    expect(readFrontmatter(note)).toEqual({ id: "d1", status: "proposed", decided_on: "", tags: ["a"] });
    expect(readFrontmatter(`﻿${note.replaceAll("\n", "\r\n")}`)).toMatchObject({ status: "proposed" });
    expect(readFrontmatter("# No frontmatter")).toBeNull();
    expect(readFrontmatter("---\n- a list\n---\n")).toBeNull();
    expect(readFrontmatter("---\nkey: [unclosed\n---\n")).toBeNull();
    expect(readFrontmatter("---\n---\n# Empty")).toEqual({});
  });

  it("keeps dates as strings", () => {
    expect(readFrontmatter("---\nupdated: 2026-09-30\n---\n")).toEqual({ updated: "2026-09-30" });
  });
});

describe("setFrontmatter", () => {
  it("changes, adds, and removes keys while keeping comments, order, and the body", () => {
    const after = setFrontmatter(note, { status: "accepted", decided_on: "2026-10-01", energy: 3, tags: null });
    expect(after).toBe(["---", 'id: "d1"', "# kept comment", 'status: "accepted"', 'decided_on: "2026-10-01"', "energy: 3", "---", "", "# Decision", "", "Body stays."].join("\n"));
  });

  it("keeps CRLF line endings", () => {
    const after = setFrontmatter(note.replaceAll("\n", "\r\n"), { status: "accepted" });
    expect(after.replaceAll("\r\n", "")).not.toContain("\n");
    expect(after).toContain('status: "accepted"\r\n');
  });

  it("leaves starter notes byte-identical when nothing changes", async () => {
    for (const path of ["Home.md", "system/Method.md", "_templates/Decision.md"]) {
      const content = await readFile(new URL(`../../../templates/starter-vault/${path}`, import.meta.url), "utf8");
      expect(setFrontmatter(content, {})).toBe(content);
    }
  });

  it("refuses notes without valid frontmatter", () => {
    expect(() => setFrontmatter("# Plain", { status: "x" })).toThrow(/no frontmatter/);
    expect(() => setFrontmatter("---\nkey: [unclosed\n---\n", { status: "x" })).toThrow(/not a valid YAML mapping/);
  });
});
