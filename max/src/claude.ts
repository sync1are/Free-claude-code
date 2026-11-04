// Detect, install, and launch Claude Code.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PKG = "@anthropic-ai/claude-code";

export function hasCommand(cmd: string): boolean {
  const r = spawnSync(cmd, ["--version"], { shell: true, encoding: "utf8" });
  return r.status === 0;
}

export function claudeVersion(): string | null {
  try {
    const r = spawnSync("claude", ["--version"], { shell: true, encoding: "utf8", timeout: 30_000 });
    if (r.status === 0) {
      const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
      if (out) {
        // "2.1.x (Claude Code)" style output
        return (out.match(/[\d]+\.[\d]+\.[\d]+/)?.[0] ?? out).trim();
      }
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

  if (spawnSync("npm", ["--version"], { shell: true, encoding: "utf8" }).status !== 0) {
    console.error("max: npm not found but Claude Code is not installed.");
    console.error("    Install Node.js (https://nodejs.org) first, then re-run this command.");
    process.exit(1);
  }

  console.log(`max: Claude Code not found — installing ${PKG} via npm (one-time, ~1-2 min)...`);
  // npm >= 11 gates install scripts; allow claude-code's explicitly, fall back if unsupported.
  const inst =
    spawnSync("npm", ["install", "-g", "--allow-scripts=" + PKG, PKG], { stdio: "inherit", shell: true }).status ??
    1;
  if (inst !== 0) {
    const fallback = spawnSync("npm", ["install", "-g", PKG], { stdio: "inherit", shell: true });
    if (fallback.status !== 0) {
      console.error("max: npm install failed. You can try manually:");
      console.error(`    npm install -g --allow-scripts=${PKG} ${PKG}`);
      process.exit(1);
    }
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

/** Direct path to the globally installed cli.js — avoids .cmd shims entirely. */
function claudeJsPath(): string | null {
  try {
    const rootRes = spawnSync("npm", ["root", "-g"], { shell: true, encoding: "utf8", timeout: 20_000 });
    if (rootRes.status !== 0) return null;
    const js = path.join((rootRes.stdout ?? "").trim(), "@anthropic-ai", "claude-code", "cli.js");
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
    const js = claudeJsPath();
    const child = js
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
