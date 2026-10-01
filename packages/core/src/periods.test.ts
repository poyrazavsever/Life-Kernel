import { describe, expect, it } from "vitest";
import { periodKey, periodRange } from "./periods.js";

describe("periodKey", () => {
  it("names days, ISO weeks, months, and quarters", () => {
    expect(periodKey("day", "2026-10-01")).toBe("2026-10-01");
    expect(periodKey("week", "2026-10-01")).toBe("2026-W40");
    expect(periodKey("month", "2026-10-01")).toBe("2026-10");
    expect(periodKey("quarter", "2026-10-01")).toBe("2026-Q4");
  });

  it("puts ISO weeks that cross a year boundary in the right year", () => {
    expect(periodKey("week", "2027-01-01")).toBe("2026-W53");
    expect(periodKey("week", "2024-12-30")).toBe("2025-W01");
    expect(periodKey("week", "2026-01-04")).toBe("2026-W01");
  });

  it("rejects dates that do not exist", () => {
    expect(() => periodKey("day", "2026-02-30")).toThrow(/real calendar date/);
    expect(() => periodKey("week", "30-09-2026")).toThrow(/real calendar date/);
  });
});

describe("periodRange", () => {
  it("returns inclusive first and last dates", () => {
    expect(periodRange("week", "2026-10-01")).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(periodRange("week", "2026-10-04")).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(periodRange("month", "2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(periodRange("quarter", "2026-11-15")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(periodRange("day", "2026-10-01")).toEqual({ start: "2026-10-01", end: "2026-10-01" });
  });
});
