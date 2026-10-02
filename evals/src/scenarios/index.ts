import { dailyCircle, hostileInbox } from "./dailyCircle.js";
import { onboarding } from "./onboarding.js";
import { approvalDiscipline, retrieval, weeklyReview } from "./others.js";
import type { Scenario } from "../types.js";

export const scenarios: Scenario[] = [onboarding, dailyCircle, hostileInbox, approvalDiscipline, weeklyReview, retrieval];

export function scenarioById(id: string): Scenario {
  const found = scenarios.find((scenario) => scenario.id === id);
  if (!found) throw new Error(`Unknown scenario ${id}. Known: ${scenarios.map((scenario) => scenario.id).join(", ")}.`);
  return found;
}
