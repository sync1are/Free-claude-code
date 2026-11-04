// Non-secret settings live in ~/.max/config.json
// API keys never go here — see keyring.ts (Windows Credential Manager).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProviderPrefs {
  /** preferred primary ("sonnet") model id */
  model?: string;
  /** preferred opus-tier model id */
  opus?: string;
  /** preferred haiku-tier model id */
  haiku?: string;
}

export interface ConfigShape {
  version: number;
  /** which secret backend worked; avoids probing every time */
  credentialBackend?: "vault" | "file";
  prefs: Record<string, ProviderPrefs>;
}

export function configDir(): string {
  return process.env.MAX_CONFIG_DIR || path.join(os.homedir(), ".max");
}

export function configFile(): string {
  return path.join(configDir(), "config.json");
}

function ensureDir(): void {
  fs.mkdirSync(configDir(), { recursive: true });
}

export function loadConfig(): ConfigShape {
  const file = configFile();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as ConfigShape;
    parsed.prefs = parsed.prefs ?? {};
    return parsed;
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      // broken JSON -> back it up and start fresh rather than crash
      try {
        fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
      } catch {}
      process.stderr.write(
        `max: warning: ${file} was unreadable (${err.message}); backed it up and started a new one\n`,
      );
    }
    return { version: 1, prefs: {} };
  }
}

export function saveConfig(cfg: ConfigShape): void {
  ensureDir();
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function updateConfig(mut: (cfg: ConfigShape) => void): ConfigShape {
  const cfg = loadConfig();
  mut(cfg);
  saveConfig(cfg);
  return cfg;
}

export function getProviderPrefs(cfg: ConfigShape, providerId: string): ProviderPrefs {
  return cfg.prefs[providerId] ?? {};
}

export function setProviderPrefs(providerId: string, patch: ProviderPrefs): void {
  updateConfig((cfg) => {
    cfg.prefs[providerId] = { ...(cfg.prefs[providerId] ?? {}), ...patch };
  });
}

/** Generic JSON cache helpers (used for the models cache). */
export function readJsonCache<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonCache(file: string, data: unknown): void {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}
