// API key storage.
//
// Primary backend: Windows Credential Manager via the WinRT PasswordVault,
// driven through powershell.exe (zero npm dependencies). Values never appear
// on the command line — the script is passed base64/UTF-16 encoded.
//
// Fallback backend: ~/.max/keyring.json (plain JSON, restricted to the user
// directory) when the vault is unavailable (e.g. non-Windows or broken PS).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir, loadConfig, updateConfig } from "./config";

const SERVICE = "MaxCLI";

function keyringFile(): string {
  return path.join(configDir(), "keyring.json");
}

function encodePS(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPS(script: string): { stdout: string; exitCode: number } {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePS(script)],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );
  return {
    stdout: (r.stdout ?? "").toString().trim(),
    exitCode: r.status ?? 1,
  };
}

const PS_TYPE = "[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]";

function psQuote(s: string): string {
  // PowerShell single-quoted literal: double embedded single quotes.
  return `'${s.replace(/'/g, "''")}'`;
}

let vaultProbeCache: boolean | null = null;

function vaultUsable(): boolean {
  if (vaultProbeCache !== null) return vaultProbeCache;
  try {
    const script = `$v = ${PS_TYPE}\n$all = $v.RetrieveAll()\n[Console]::Error.Write([string]$all.Count)\nexit 0\n`;
    const r = runPS(script);
    vaultProbeCache = r.exitCode === 0;
  } catch {
    vaultProbeCache = false;
  }
  if (!vaultProbeCache) {
    process.stderr.write(
      "max: Windows Credential Manager unavailable — falling back to plain ~/.max/keyring.json (less secure)\n",
    );
  }
  return vaultProbeCache;
}

const NOT_FOUND_EXIT = 9;

function vaultGet(providerId: string): string | null | undefined {
  // returns secret | null (not found) | undefined (vault broken)
  const script = `$v = ${PS_TYPE}
try { $c = $v.Retrieve(${psQuote(SERVICE)}, ${psQuote(providerId)}) }
catch { exit ${NOT_FOUND_EXIT} }
try { $c.RetrievePassword() } catch { exit 1 }
[Console]::Out.Write($c.Password)
exit 0`;
  const r = runPS(script);
  if (r.exitCode === NOT_FOUND_EXIT) return null;
  if (r.exitCode !== 0) return undefined;
  return r.stdout;
}

function vaultSet(providerId: string, secret: string): boolean {
  const script = `$v = ${PS_TYPE}
$old = $null
try { $old = $v.Retrieve(${psQuote(SERVICE)}, ${psQuote(providerId)}) } catch {}
if ($old) { $v.Remove($old) }
$c = New-Object Windows.Security.Credentials.PasswordCredential(${psQuote(SERVICE)}, ${psQuote(providerId)}, ${psQuote(secret)})
$v.Add($c)
exit 0`;
  return runPS(script).exitCode === 0;
}

function vaultRemove(providerId: string): boolean {
  const script = `$v = ${PS_TYPE}
try { $c = $v.Retrieve(${psQuote(SERVICE)}, ${psQuote(providerId)}) } catch { exit 0 }
$v.Remove($c)
exit 0`;
  return runPS(script).exitCode === 0;
}

// ---------- file fallback ----------

function fileGet(providerId: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(keyringFile(), "utf8"));
    return typeof j[providerId] === "string" ? j[providerId] : null;
  } catch {
    return null;
  }
}

function fileSet(providerId: string, secret: string): void {
  let j: Record<string, string> = {};
  try {
    j = JSON.parse(fs.readFileSync(keyringFile(), "utf8"));
  } catch {}
  j[providerId] = secret;
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(keyringFile(), JSON.stringify(j, null, 2) + "\n", "utf8");
  try {
    if (process.platform === "win32") {
      // restrict to current user, best effort
      spawnSync("icacls", [keyringFile(), "/inheritance:r", "/grant:r", `${os.userInfo().username}:F`], {
        windowsHide: true,
      });
    } else {
      fs.chmodSync(keyringFile(), 0o600);
    }
  } catch {}
}

function fileRemove(providerId: string): void {
  try {
    const j = JSON.parse(fs.readFileSync(keyringFile(), "utf8"));
    delete j[providerId];
    fs.writeFileSync(keyringFile(), JSON.stringify(j, null, 2) + "\n", "utf8");
  } catch {}
}

// ---------- public API ----------

export interface SecretInfo {
  secret: string;
  backend: "vault" | "file";
}

export function getSecret(providerId: string): SecretInfo | null {
  const cfg = loadConfig();
  if (cfg.credentialBackend === "file") {
    const s = fileGet(providerId);
    return s ? { secret: s, backend: "file" } : null;
  }

  if (vaultUsable()) {
    const s = vaultGet(providerId);
    if (s !== undefined) return s ? { secret: s, backend: "vault" } : null;
  }

  const s = fileGet(providerId);
  return s ? { secret: s, backend: "file" } : null;
}

export function setSecret(providerId: string, secret: string): "vault" | "file" {
  if (vaultUsable() && vaultSet(providerId, secret)) {
    updateConfig((cfg) => {
      cfg.credentialBackend = "vault";
    });
    return "vault";
  }
  fileSet(providerId, secret);
  updateConfig((cfg) => {
    cfg.credentialBackend = "file";
  });
  return "file";
}

export function removeSecret(providerId: string): void {
  vaultRemove(providerId);
  fileRemove(providerId);
}

export function keyringFileForDisplay(): string {
  return keyringFile();
}
