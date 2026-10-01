import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SchedulePaths {
  /** Absolute path of the Node.js binary. */
  node: string;
  /** Absolute path of the built CLI. */
  cli: string;
  /** Absolute path of lifekernel.config.json. */
  config: string;
  stateDir: string;
  home: string;
  uid?: number;
}

export interface ScheduleCommand { argv: string[]; allowFailure?: boolean; verbatim?: boolean }
export interface SchedulePlan {
  platform: NodeJS.Platform;
  files: Array<{ path: string; content: string }>;
  install: ScheduleCommand[];
  uninstall: ScheduleCommand[];
  status: ScheduleCommand;
}

const TASK = "LifeKernel\\Tick";
const LABEL = "dev.lifekernel.tick";
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const systemdQuote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The files and commands that run `lifekernel tick` every few minutes with the operating system's own
 * scheduler: Task Scheduler on Windows, launchd on macOS, and a systemd user timer on Linux.
 */
export function schedulePlan(platform: NodeJS.Platform, paths: SchedulePaths, everyMinutes = 5): SchedulePlan {
  if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 60) throw new Error("--every must be between 1 and 60 minutes.");
  const lastTick = join(paths.stateDir, "last-tick.json");
  if (platform === "win32") {
    // A wrapper script keeps the task command short and free of nested quoting. The file is UTF-8, but Task
    // Scheduler runs it under the OEM code page (857 on Turkish Windows), which would garble a path such as
    // C:\Yazılım; chcp 65001 makes cmd.exe read the paths as written.
    const script = join(paths.stateDir, "lifekernel-tick.cmd");
    return {
      platform,
      files: [{ path: script, content: `@echo off\r\nchcp 65001 >nul\r\n"${paths.node}" "${paths.cli}" tick --config "${paths.config}" > "${lastTick}" 2>&1\r\n` }],
      install: [{ argv: ["schtasks", "/Create", "/TN", TASK, "/SC", "MINUTE", "/MO", String(everyMinutes), "/TR", `"\\"${script}\\""`, "/F"], verbatim: true }],
      uninstall: [{ argv: ["schtasks", "/Delete", "/TN", TASK, "/F"], allowFailure: true }],
      status: { argv: ["schtasks", "/Query", "/TN", TASK, "/FO", "LIST"] }
    };
  }
  if (platform === "darwin") {
    const plist = join(paths.home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const domain = `gui/${paths.uid ?? 501}`;
    const args = [paths.node, paths.cli, "tick", "--config", paths.config].map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
    return {
      platform,
      files: [{ path: plist, content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${everyMinutes * 60}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(lastTick)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(lastTick)}</string>
</dict>
</plist>
` }],
      install: [{ argv: ["launchctl", "bootout", `${domain}/${LABEL}`], allowFailure: true }, { argv: ["launchctl", "bootstrap", domain, plist] }],
      uninstall: [{ argv: ["launchctl", "bootout", `${domain}/${LABEL}`], allowFailure: true }],
      status: { argv: ["launchctl", "print", `${domain}/${LABEL}`] }
    };
  }
  const units = join(paths.home, ".config", "systemd", "user");
  return {
    platform,
    files: [
      { path: join(units, "lifekernel-tick.service"), content: `[Unit]\nDescription=Life Kernel ritual reminders\n\n[Service]\nType=oneshot\nExecStart=${[paths.node, paths.cli, "tick", "--config", paths.config].map(systemdQuote).join(" ")}\n` },
      { path: join(units, "lifekernel-tick.timer"), content: `[Unit]\nDescription=Check Life Kernel rituals every ${everyMinutes} minutes\n\n[Timer]\nOnCalendar=*:0/${everyMinutes}\nPersistent=true\nAccuracySec=30s\n\n[Install]\nWantedBy=timers.target\n` }
    ],
    install: [{ argv: ["systemctl", "--user", "daemon-reload"] }, { argv: ["systemctl", "--user", "enable", "--now", "lifekernel-tick.timer"] }],
    uninstall: [{ argv: ["systemctl", "--user", "disable", "--now", "lifekernel-tick.timer"], allowFailure: true }],
    status: { argv: ["systemctl", "--user", "status", "lifekernel-tick.timer", "--no-pager"] }
  };
}

function run(command: ScheduleCommand): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const [file, ...args] = command.argv;
    execFile(file!, args, { windowsHide: true, windowsVerbatimArguments: command.verbatim ?? false, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}`.trim() });
    });
  });
}

/** Install, remove, or inspect the scheduled check. With `dryRun`, only describe what would happen. */
export async function manageSchedule(action: "install" | "uninstall" | "status", plan: SchedulePlan, dryRun: boolean) {
  if (dryRun) return { action, dryRun, files: plan.files, commands: (action === "install" ? plan.install : action === "uninstall" ? plan.uninstall : [plan.status]).map((command) => command.argv) };
  if (action === "status") {
    const result = await run(plan.status);
    return { action, installed: result.ok, output: result.output };
  }
  if (action === "install") for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, "utf8");
  }
  const steps = [];
  for (const command of action === "install" ? plan.install : plan.uninstall) {
    const result = await run(command);
    steps.push({ command: command.argv.join(" "), ok: result.ok, ...(result.ok ? {} : { output: result.output }) });
    if (!result.ok && !command.allowFailure) {
      const hint = plan.platform === "linux" ? " Without systemd, add this line with crontab -e instead: */5 * * * * <node> <cli> tick --config <config>" : "";
      throw new Error(`${command.argv[0]} failed: ${result.output || "no output"}.${hint}`);
    }
  }
  if (action === "uninstall") for (const file of plan.files) await rm(file.path, { force: true });
  return { action, ok: true, steps, files: plan.files.map((file) => file.path) };
}
