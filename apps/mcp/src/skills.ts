import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Skill { name: string; description: string; body: string }

export function defaultSkillsDir(): string {
  if (process.env.LIFEKERNEL_SKILLS_DIR) return resolve(process.env.LIFEKERNEL_SKILLS_DIR);
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills");
}

function parse(raw: string, fallback: string): Skill {
  const text = raw.replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n+/);
  const frontmatter = match?.[1] ?? "";
  const body = match ? text.slice(match[0].length) : text;
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return { name: fallback, description, body: body.trim() };
}

/** Load canonical skills from `<dir>/<name>/SKILL.md`. A missing directory yields no skills. */
export function loadSkills(dir: string = defaultSkillsDir()): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
    .map((entry) => parse(readFileSync(join(dir, entry.name, "SKILL.md"), "utf8"), entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
