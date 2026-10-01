import { detectEol, frontmatterEnd } from "./frontmatter.js";

interface Heading { index: number; level: number; text: string }

/** Markdown headings outside frontmatter and fenced code. */
function headings(lines: string[]): Heading[] {
  const found: Heading[] = [];
  let fence: string | null = null;
  for (let index = frontmatterEnd(lines); index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (match) found.push({ index, level: match[1]!.length, text: match[2]!.trim() });
  }
  return found;
}

/** The single heading with this text and the index where its section ends (the next heading of the same or higher level). */
function locate(lines: string[], heading: string): { target: Heading; end: number } {
  const wanted = heading.replace(/^#+\s*/, "").trim();
  const all = headings(lines);
  const matches = all.filter((candidate) => candidate.text === wanted);
  if (matches.length === 0) throw new Error(`Section not found: ${wanted}`);
  if (matches.length > 1) throw new Error(`Section heading is ambiguous: ${wanted}`);
  const target = matches[0]!;
  const next = all.find((candidate) => candidate.index > target.index && candidate.level <= target.level);
  return { target, end: next ? next.index : lines.length };
}

/** The trimmed body under a heading, including nested headings; null when the heading is missing or ambiguous. */
export function readSection(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  try {
    const { target, end } = locate(lines, heading);
    return lines.slice(target.index + 1, end).join("\n").trim();
  } catch {
    return null;
  }
}

/** Replace the body under one heading, up to the next heading of the same or higher level. */
export function replaceSection(content: string, heading: string, body: string): { content: string; section: string } {
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const { target, end } = locate(lines, heading);
  const replacement = [lines[target.index]!, "", ...body.trim().split(/\r?\n/), ""];
  const rebuilt = [...lines.slice(0, target.index), ...replacement, ...lines.slice(end)];
  return { content: rebuilt.join(eol).replace(/(\r?\n)*$/, eol), section: replacement.join(eol).trim() };
}
