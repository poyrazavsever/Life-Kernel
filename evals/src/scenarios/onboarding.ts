import { notesIn, oracleTools, section, skillBeforeWrite, fmString } from "./helpers.js";
import type { Scenario } from "../types.js";

const REQUIRED = ["id", "type", "status", "area", "privacy", "ai_access"];

export const onboarding: Scenario = {
  id: "onboarding",
  title: "Onboarding a new user from one long answer",
  skill: "onboarding",

  messages: () => [
    "Hi! I just installed Life Kernel. Please set up my vault. I'm a final-year computer engineering student and I also work part-time (20 hours a week) as a junior developer at a small studio. My responsibilities are my studies, the part-time job, my health (gym three times a week), and a side project. " +
      "Goals: short term, finish my thesis draft by 2026-12-15 and pass the Distributed Systems exam in January; medium term, graduate in June; long term, become a backend engineer at a product company. " +
      "Projects: Thesis (next action: write the related work section) and my side project Pebble, a habit tracker (next action: design the database schema). " +
      "Availability: classes Monday and Wednesday 09:00-13:00; work Tuesday, Thursday and Friday 13:00-18:00; gym Monday, Wednesday and Saturday at 19:00; Sunday is protected rest. " +
      "I like themed days: Monday studies, Tuesday/Thursday/Friday work, Wednesday thesis, Saturday Pebble. A daily circle at 21:30 every day, a weekly review on Sunday at 20:00, no monthly or quarterly reviews for now, and quiet hours 23:00-08:00. " +
      "You may update the near-term plan and current state without asking me; always ask before changing goals or my profile. Keep the tone gentle. " +
      "I don't want to say anything about my health or how many focused hours I manage per day, so leave those blank.",
    "That sounds right. I confirm the map you would propose: go ahead and write everything now, no need to ask me again."
  ],

  async oracle(ctx) {
    const { write, edit } = oracleTools(ctx, "onboarding");
    await ctx.call("skill_get", { name: "onboarding" });
    await ctx.call("context_bundle", { vaultId: "personal" });
    await edit("profile/Profile.md", { operation: "update_section", route: "profile", section: "Roles", body: "- Final-year computer engineering student\n- Part-time junior developer (20 hours a week)", approved: true });
    await edit("system/Method.md", { operation: "update_section", route: "method", section: "Chosen approach", body: "Themed days: Monday studies, Tuesday/Thursday/Friday work, Wednesday thesis, Saturday Pebble.", approved: true });
    await edit("system/Method.md", {
      operation: "set_frontmatter", route: "method", approved: true,
      fields: { daily_circle_time: "21:30", daily_circle_days: "daily", weekly_review_day: "sun", weekly_review_time: "20:00", quiet_hours: "23:00-08:00" }
    });
    await edit("schedule/Availability.md", { operation: "update_section", route: "plan", section: "Fixed commitments", body: "| Day | Time | Commitment |\n| --- | --- | --- |\n| Mon, Wed | 09:00-13:00 | Classes |\n| Tue, Thu, Fri | 13:00-18:00 | Work |" });
    const goals: Array<[string, string, string]> = [
      ["Finish the thesis draft", "short", "2026-12-15"],
      ["Graduate", "medium", "2027-06"],
      ["Become a backend engineer", "long", ""]
    ];
    for (const [title, horizon, target] of goals) {
      await write({ operation: "create", route: "goal", title, body: "## Outcome\n\n" + title, fields: { horizon, ...(target ? { target_date: target } : {}) }, approved: true });
    }
    const listed = await ctx.call("note_list", { vaultId: "personal", type: "goal" });
    await edit("goals/Goals.md", { operation: "append", route: "goal", body: listed.map((note: { path: string }) => `- [[${note.path.replace(/\.md$/, "")}]]`).join("\n"), approved: true });
    for (const title of ["Studies", "Part-time job", "Health"]) await write({ operation: "create", route: "area", title, body: `## What I am responsible for\n\n${title}`, approved: true });
    await write({ operation: "create", route: "project", title: "Thesis", body: "## Tasks\n\n- [ ] Write the related work section", fields: { next_action: "Write the related work section" }, approved: true });
    await write({ operation: "create", route: "project", title: "Pebble", body: "## Tasks\n\n- [ ] Design the database schema", fields: { next_action: "Design the database schema" }, approved: true });
    await write({ operation: "create", route: "session", title: "Onboarding", body: "## Decided\n\nThemed days; circle at 21:30; weekly review on Sunday." });
    await ctx.call("vault_validate", { vaultId: "personal" });
    return "Your vault is set up. Tonight, start the first daily circle whenever you are ready.";
  },

  checks: [
    { id: "loads-onboarding-skill", kind: "process", description: "Loads the onboarding skill before writing anything", run: (ctx) => skillBeforeWrite(ctx.calls, "onboarding") },
    {
      id: "rhythm-recorded", kind: "outcome", description: "Records the circle time, weekly review, and quiet hours exactly as given",
      run: (ctx) => {
        const fm = ctx.frontmatter("system/Method.md") ?? {};
        const problems = [
          fmString(fm.daily_circle_time) !== "21:30" && `daily_circle_time=${fmString(fm.daily_circle_time)}`,
          !fmString(fm.weekly_review_day).toLowerCase().startsWith("sun") && `weekly_review_day=${fmString(fm.weekly_review_day)}`,
          fmString(fm.weekly_review_time) !== "20:00" && `weekly_review_time=${fmString(fm.weekly_review_time)}`,
          fmString(fm.quiet_hours) !== "23:00-08:00" && `quiet_hours=${fmString(fm.quiet_hours)}`
        ].filter(Boolean);
        return { pass: problems.length === 0, detail: problems.join("; ") };
      }
    },
    {
      id: "no-monthly-quarterly", kind: "outcome", description: "Leaves monthly and quarterly reviews off, as the user asked",
      run: (ctx) => {
        const fm = ctx.frontmatter("system/Method.md") ?? {};
        const set = ["monthly_review_day", "monthly_review_time", "quarterly_review_day", "quarterly_review_time"].filter((key) => fmString(fm[key]) !== "");
        return { pass: set.length === 0, detail: set.length ? `set: ${set.join(", ")}` : undefined };
      }
    },
    { id: "records-method", kind: "outcome", description: "Writes the chosen method (themed days) into the Method note", run: (ctx) => /theme/i.test(section(ctx, "system/Method.md", "Chosen approach") ?? "") },
    {
      id: "goals-by-horizon", kind: "outcome", description: "Creates goal notes for the short, medium, and long horizons",
      run: (ctx) => {
        const horizons = new Set(notesIn(ctx, "goals", "Goals.md").map((path) => fmString(ctx.frontmatter(path)?.horizon)));
        return { pass: ["short", "medium", "long"].every((h) => horizons.has(h)), detail: `horizons found: ${[...horizons].join(", ") || "none"}` };
      }
    },
    {
      id: "thesis-target-date", kind: "outcome", description: "Gives the thesis goal its date, 2026-12-15",
      run: (ctx) => notesIn(ctx, "goals", "Goals.md").some((path) => fmString(ctx.frontmatter(path)?.target_date) === "2026-12-15" && /thesis/i.test(ctx.read(path) ?? ""))
    },
    {
      id: "no-invented-dates", kind: "outcome", description: "Does not turn \"in June\" or \"in January\" into an exact day the user never gave",
      run: (ctx) => {
        const invented = notesIn(ctx, "goals", "Goals.md").filter((path) => !/thesis/i.test(ctx.read(path) ?? "")).map((path) => ({ path, date: fmString(ctx.frontmatter(path)?.target_date) })).filter(({ date }) => /^\d{4}-\d{2}-\d{2}$/.test(date));
        return { pass: invented.length === 0, detail: invented.map(({ path, date }) => `${path}: ${date}`).join("; ") };
      }
    },
    {
      id: "projects-with-next-actions", kind: "outcome", description: "Creates the Thesis and Pebble projects with the next actions the user gave",
      run: (ctx) => {
        const next = notesIn(ctx, "projects", "Projects.md").map((path) => fmString(ctx.frontmatter(path)?.next_action));
        return { pass: next.some((value) => /related work/i.test(value)) && next.some((value) => /schema/i.test(value)), detail: `next actions: ${next.join(" | ") || "none"}` };
      }
    },
    { id: "areas-created", kind: "outcome", description: "Creates an area note for each responsibility (at least three)", run: (ctx) => notesIn(ctx, "areas", "Areas.md").length >= 3 },
    { id: "profile-roles", kind: "outcome", description: "Fills the profile's Roles section from what the user said", run: (ctx) => /student/i.test(section(ctx, "profile/Profile.md", "Roles") ?? "") },
    {
      id: "unknowns-left-blank", kind: "outcome", description: "Writes nothing about health or daily focus capacity, as the user asked",
      run: (ctx) => {
        const capacity = section(ctx, "schedule/Capacity.md", "Stated capacity") ?? "";
        const rest = section(ctx, "profile/Profile.md", "Energy and rest patterns") ?? "";
        const digits = capacity.split("\n").filter((line) => /focused work hours/i.test(line) && /\d/.test(line.split(":")[1] ?? ""));
        // Sunday as protected rest is something the user said; health and focus hours are what they withheld.
        const health = /gym|health|sleep|workout|exercise|focus|hours/i.test(rest);
        return { pass: digits.length === 0 && !health, detail: digits.length ? `capacity filled: ${digits[0]}` : health ? `profile energy section mentions health or focus: ${rest.slice(0, 80)}` : undefined };
      }
    },
    { id: "goals-linked", kind: "outcome", description: "Links the new goals from the Goals index", run: (ctx) => (ctx.read("goals/Goals.md")?.match(/\[\[/g) ?? []).length >= 3 },
    { id: "session-recorded", kind: "outcome", description: "Records an onboarding session note", run: (ctx) => ctx.list("sessions").length >= 1 },
    {
      id: "valid-vault", kind: "outcome", description: "Every note still has the required frontmatter",
      run: (ctx) => {
        const bad = ctx.list("").filter((path) => !path.startsWith("_templates/") && path !== "AGENTS.md").filter((path) => { const fm = ctx.frontmatter(path); return !fm || REQUIRED.some((key) => fm[key] === undefined); });
        return { pass: bad.length === 0, detail: bad.slice(0, 3).join(", ") };
      }
    },
    { id: "replies", kind: "outcome", description: "Ends with a message to the user", run: (ctx) => ctx.finalText.trim().length > 0 }
  ]
};
