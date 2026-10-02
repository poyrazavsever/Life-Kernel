import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manageSchedule, schedulePlan } from "./schedule.js";

const paths = { node: "/usr/bin/node", cli: "/opt/life kernel/apps/cli/dist/index.js", config: "/home/u/life kernel/lifekernel.config.json", stateDir: "/home/u/.lifekernel-data", home: "/home/u", uid: 1000 };

describe("schedulePlan", () => {
  it("registers a Windows task that runs a wrapper script, quoted for paths with spaces", () => {
    const plan = schedulePlan("win32", { ...paths, node: "C:\\Program Files\\nodejs\\node.exe", cli: "C:\\Life Kernel\\cli.js", config: "C:\\Life Kernel\\lifekernel.config.json", stateDir: "C:\\Life Kernel\\state" }, 5);
    expect(plan.files[0]!.path).toMatch(/lifekernel-tick\.cmd$/);
    const script = plan.files[0]!.content;
    expect(script.startsWith('@echo off\r\nchcp 65001 >nul\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\Life Kernel\\cli.js" tick --config "C:\\Life Kernel\\lifekernel.config.json" > "C:\\Life Kernel\\state')).toBe(true);
    expect(script.endsWith('last-tick.json" 2>&1\r\n')).toBe(true);
    expect(plan.install[0]).toMatchObject({ verbatim: true, argv: ["schtasks", "/Create", "/TN", "LifeKernel\\Tick", "/SC", "MINUTE", "/MO", "5", "/TR", expect.stringMatching(/^"\\".*lifekernel-tick\.cmd\\""$/), "/F"] });
    expect(plan.uninstall[0]).toMatchObject({ argv: ["schtasks", "/Delete", "/TN", "LifeKernel\\Tick", "/F"], allowFailure: true });
  });

  it("writes a launchd agent with escaped arguments on macOS", () => {
    const plan = schedulePlan("darwin", { ...paths, config: "/Users/u/a&b/lifekernel.config.json", home: "/Users/u", uid: 501 }, 10);
    expect(plan.files[0]!.path).toMatch(/Library[\\/]LaunchAgents[\\/]dev\.lifekernel\.tick\.plist$/);
    expect(plan.files[0]!.content).toContain("<string>/Users/u/a&amp;b/lifekernel.config.json</string>");
    expect(plan.files[0]!.content).toContain("<integer>600</integer>");
    expect(plan.install.map((command) => command.argv.slice(0, 2))).toEqual([["launchctl", "bootout"], ["launchctl", "bootstrap"]]);
    expect(plan.install[1]!.argv[2]).toBe("gui/501");
  });

  it("writes a systemd user timer on Linux with quoted paths", () => {
    const plan = schedulePlan("linux", paths, 5);
    const [service, timer] = plan.files;
    expect(service!.content).toContain('ExecStart="/usr/bin/node" "/opt/life kernel/apps/cli/dist/index.js" "tick" "--config" "/home/u/life kernel/lifekernel.config.json"');
    expect(timer!.content).toContain("OnCalendar=*:0/5\nPersistent=true");
    expect(plan.install.at(-1)!.argv).toEqual(["systemctl", "--user", "enable", "--now", "lifekernel-tick.timer"]);
  });

  it("rejects an interval outside one to sixty minutes", () => {
    expect(() => schedulePlan("linux", paths, 0)).toThrow(/between 1 and 60/);
    expect(() => schedulePlan("linux", paths, 1.5)).toThrow(/between 1 and 60/);
  });
});

describe("manageSchedule", () => {
  it("only describes the change in a dry run", async () => {
    const plan = schedulePlan("linux", paths, 5);
    await expect(manageSchedule("install", plan, true)).resolves.toEqual({ action: "install", dryRun: true, files: plan.files, commands: plan.install.map((command) => command.argv) });
    await expect(manageSchedule("status", plan, true)).resolves.toMatchObject({ commands: [["systemctl", "--user", "status", "lifekernel-tick.timer", "--no-pager"]] });
  });
});

describe.skipIf(process.platform !== "win32")("Windows wrapper script", () => {
  it("runs from a path with non-ASCII letters under the Turkish OEM code page", () => {
    const root = join(mkdtempSync(join(tmpdir(), "lk-")), "Yazılım test");
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    const cli = join(root, "cli.js");
    writeFileSync(cli, 'process.stdout.write("tick-ran")');
    const plan = schedulePlan("win32", { node: process.execPath, cli, config: join(root, "lifekernel.config.json"), stateDir: state, home: root }, 5);
    const script = join(state, "lifekernel-tick.cmd");
    writeFileSync(script, plan.files[0]!.content, "utf8");
    // 857 is the code page Task Scheduler's console uses on Turkish Windows; without chcp the path is unreadable.
    const run = spawnSync("cmd.exe", ["/d", "/c", `chcp 857 >nul & "${script}"`], { windowsVerbatimArguments: true });
    expect(run.status).toBe(0);
    expect(readFileSync(join(state, "last-tick.json"), "utf8")).toContain("tick-ran");
  });
});
