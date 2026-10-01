import { frontmatterEnd } from "./frontmatter.js";

export type TaskStatus = "open" | "in-progress" | "done" | "cancelled";
export type TaskPriority = "highest" | "high" | "medium" | "low" | "lowest";

export interface Task {
  line: number;
  text: string;
  status: TaskStatus;
  due?: string;
  scheduled?: string;
  start?: string;
  done?: string;
  priority?: TaskPriority;
  recurrence?: string;
}

// Obsidian Tasks signifiers. Each emoji may carry a variation selector.
const DATE_FIELDS = { due: "\u{1F4C5}", scheduled: "⏳", start: "\u{1F6EB}", done: "✅" } as const;
const PRIORITIES: Record<string, TaskPriority> = { "\u{1F53A}": "highest", "⏫": "high", "\u{1F53C}": "medium", "\u{1F53D}": "low", "⏬": "lowest" };
const RECURRENCE = "\u{1F501}";
const CREATED = "➕";
const SIGNIFIERS = [...Object.values(DATE_FIELDS), ...Object.keys(PRIORITIES), RECURRENCE, CREATED];
const SIGNIFIER = new RegExp(`(?:${SIGNIFIERS.join("|")})\\uFE0F?`, "u");

function statusFor(mark: string): TaskStatus {
  if (mark === "x" || mark === "X") return "done";
  if (mark === "-") return "cancelled";
  if (mark === "/") return "in-progress";
  return "open";
}

/** Parse `- [ ]` checklist items with Obsidian Tasks metadata. Frontmatter and fenced code are skipped. */
export function parseTasks(content: string): Task[] {
  const lines = content.split(/\r?\n/);
  const tasks: Task[] = [];
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
    const match = line.match(/^\s*[-*+]\s+\[(.)\]\s+(.*)$/);
    if (!match) continue;
    const rest = match[2]!;
    const task: Task = { line: index + 1, text: rest.split(SIGNIFIER)[0]!.trim(), status: statusFor(match[1]!) };
    for (const [field, emoji] of Object.entries(DATE_FIELDS) as Array<[keyof typeof DATE_FIELDS, string]>) {
      const value = rest.match(new RegExp(`${emoji}\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})`, "u"))?.[1];
      if (value) task[field] = value;
    }
    for (const [emoji, priority] of Object.entries(PRIORITIES)) if (new RegExp(`${emoji}\\uFE0F?`, "u").test(rest)) { task.priority = priority; break; }
    const recurrence = rest.split(new RegExp(`${RECURRENCE}\\uFE0F?`, "u"))[1]?.split(SIGNIFIER)[0]?.trim();
    if (recurrence) task.recurrence = recurrence;
    tasks.push(task);
  }
  return tasks;
}

export const PRIORITY_RANK: Record<TaskPriority | "none", number> = { highest: 0, high: 1, medium: 2, none: 3, low: 4, lowest: 5 };
