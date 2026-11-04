// Detect, install, and launch Claude Code.

import { spawn, spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PKG = "@anthropic-ai/claude-code";

export function hasCommand(cmd: string): boolean {
  try {
    execSync(`${cmd} --version`, { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

export function claudeVersion(): string | null {
  try {
    const out = execSync("claude --version", { encoding: "utf8", timeout: 30_000 });
    const text = String(out ?? "").trim();
    if (text) {
      // "2.1.x (Claude Code)" style output
      return (text.match(/[\d]+\.[\d]+\.[\d]+/)?.[0] ?? text).trim();
    }
  } catch {}
  return null;
}

export interface EnsureResult {
  version: string;
  installedNow: boolean;
}

export function ensureClaudeInstalled(opts: { dryRun?: boolean } = {}): EnsureResult | null {
  const existing = claudeVersion();
  if (existing) return { version: existing, installedNow: false };
  if (opts.dryRun) return null;

  if (!hasCommand("npm")) {
    console.error("max: npm not found but Claude Code is not installed.");
    console.error("    Install Node.js (https://nodejs.org) first, then re-run this command.");
    process.exit(1);
  }

  console.log(`max: Claude Code not found — installing ${PKG} via npm (one-time, ~1-2 min)...`);

  const attempts: Array<{ cmd: string; from: string }> = [
    { cmd: `npm install -g --allow-scripts=${PKG} ${PKG}`, from: "npm (allow-scripts)" },
    { cmd: `npm install -g ${PKG}`, from: "npm" },
  ];
  let installed = false;
  for (const a of attempts) {
    try {
      execSync(a.cmd, { stdio: "inherit", timeout: 300_000 });
      installed = true;
      break;
    } catch {
      // fall through to the next attempt
    }
  }
  if (!installed) {
    console.error("max: npm install failed. You can try manually:");
    console.error(`    npm install -g --allow-scripts=${PKG} ${PKG}`);
    process.exit(1);
  }

  const v = claudeVersion();
  if (!v) {
    console.error("max: Claude Code was installed but is not found on PATH.");
    console.error("    Open a NEW terminal and run the same command again.");
    process.exit(1);
  }
  return { version: v, installedNow: true };
}

function winQuote(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/, "$1$1")}"`;
}

/** Direct path to the globally installed claude binary — avoids shims entirely. */
function claudeNativePath(): string | null {
  try {
    if (process.platform !== "win32") return null;
    const rootRes = execSync("npm root -g", { encoding: "utf8", timeout: 20_000 });
    const exe = path.join(String(rootRes).trim(), "@anthropic-ai", "claude-code", "bin", "claude.exe");
    return fs.existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** Direct path to the globally installed cli.js (older claude-code releases). */
function claudeJsPath(): string | null {
  try {
    const root = execSync("npm root -g", { encoding: "utf8", timeout: 20_000 }).trim();
    const js = path.join(root, "@anthropic-ai", "claude-code", "cli.js");
    return fs.existsSync(js) ? js : null;
  } catch {
    return null;
  }
}

export interface SpawnClaudeArgs {
  claudeArgs: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Launch claude in the foreground, inheriting stdio. Resolves with its exit code. */
export function spawnClaude(args: SpawnClaudeArgs): Promise<number> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const native = claudeNativePath();
    const js = native ? null : claudeJsPath();
    const child =
      native
        ? spawn(native, args.claudeArgs, {
            stdio: "inherit",
            env: args.env,
            cwd: args.cwd,
          })
        : js
        ? spawn(process.execPath, [js, ...args.claudeArgs], {
            stdio: "inherit",
            env: args.env,
            cwd: args.cwd,
          })
        : spawn("claude", isWin ? args.claudeArgs.map(winQuote) : args.claudeArgs, {
            stdio: "inherit",
            shell: isWin,
            env: args.env,
            cwd: args.cwd,
          });

    // Ctrl+C should go to the child (it owns stdio); keep the proxy alive.
    const onSigint = () => {};
    process.on("SIGINT", onSigint);

    child.on("error", (err) => {
      process.removeListener("SIGINT", onSigint);
      reject(err);
    });
    child.on("exit", (code) => {
      process.removeListener("SIGINT", onSigint);
      resolve(code ?? 0);
    });
  });
}
