import { isMap, parseDocument } from "yaml";

export type FieldValue = string | number | boolean | null | Array<string | number>;

export function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Index of the line after the closing `---`, or 0 when the note has no frontmatter. Tolerates a BOM and trailing spaces. */
export function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) if (lines[index]!.trim() === "---") return index + 1;
  return 0;
}

/** The YAML lines between the opening and closing `---`, or "" when the note has none. Accepts LF, CRLF, and a BOM. */
export function frontmatterBlock(content: string): string {
  const lines = content.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  return end ? lines.slice(1, end - 1).join("\n") : "";
}

/** Frontmatter as plain data, or null when the note has none or it is not a valid YAML mapping. */
export function readFrontmatter(content: string): Record<string, unknown> | null {
  const lines = content.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (!end) return null;
  const document = parseDocument(lines.slice(1, end - 1).join("\n"));
  if (document.errors.length > 0) return null;
  if (document.contents === null) return {};
  if (!isMap(document.contents)) return null;
  return document.toJS() as Record<string, unknown>;
}

/**
 * Set or remove frontmatter keys while keeping every other line, comment, and key order as written.
 * `null` removes a key. Strings are written double-quoted, matching the starter vault.
 */
export function setFrontmatter(content: string, values: Record<string, FieldValue>): string {
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const end = frontmatterEnd(lines);
  if (!end) throw new Error("This note has no frontmatter to update.");
  const document = parseDocument(lines.slice(1, end - 1).join("\n"));
  if (document.errors.length > 0 || !(document.contents === null || isMap(document.contents))) throw new Error("This note's frontmatter is not a valid YAML mapping.");
  for (const [key, value] of Object.entries(values)) {
    if (value === null) { document.delete(key); continue; }
    const node = document.createNode(value);
    if (typeof value === "string") (node as { type?: string }).type = "QUOTE_DOUBLE";
    document.set(key, node);
  }
  const empty = document.contents === null || (isMap(document.contents) && document.contents.items.length === 0);
  const block = empty ? [] : document.toString({ lineWidth: 0 }).replace(/\n$/, "").split("\n");
  return [lines[0]!, ...block, lines[end - 1]!, ...lines.slice(end)].join(eol);
}
