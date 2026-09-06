import { closeSync, openSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, lstatSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "dotenv";

export class OperatorError extends Error {}

/** Preserve the template/comments while atomically saving provisioning state. */
export function updateEnv(content: string, updates: Record<string, string>): string {
  const original = parse(content);
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !/^[A-Za-z0-9.:/@_-]*$/.test(value)) {
      throw new OperatorError("Invalid provisioning configuration value");
    }
    if (/[\r\n]/.test(original[key] ?? "")) {
      throw new OperatorError("Cannot safely update .env; use single-line provisioning assignments");
    }
    const pattern = new RegExp(`^\\s*(?:export[ \\t]+)?${key}[ \\t]*=.*$`);
    let found = false;
    content = content.split("\n").filter(line => {
      if (!pattern.test(line)) return true;
      if (found) return false;
      found = true;
      return true;
    }).map(line => pattern.test(line) ? `${key}=${value}` : line).join("\n");
    if (!found) content = `${content.trimEnd()}\n${key}=${value}\n`;
  }
  const updated = parse(content);
  if (Object.entries(updates).some(([key, value]) => updated[key] !== value)
      || Object.entries(original).some(([key, value]) => !Object.hasOwn(updates, key) && updated[key] !== value)
      || Object.keys(updated).some(key => !Object.hasOwn(original, key) && !Object.hasOwn(updates, key))) {
    throw new OperatorError("Cannot safely update .env; use single-line provisioning assignments");
  }
  return content;
}

export class EnvStore {
  private content: string;
  private values: Record<string, string>;
  constructor(readonly path: string) {
    if (!lstatSync(path).isFile()) throw new OperatorError(".env must be a regular file");
    chmodSync(path, 0o600);
    this.content = readFileSync(path, "utf8");
    this.values = parse(this.content);
  }
  get(key: string): string { return this.values[key] ?? ""; }
  set(updates: Record<string, string>): void {
    // Avoid overwriting edits made manually while this process was running.
    if (readFileSync(this.path, "utf8") !== this.content) throw new OperatorError(".env changed during provisioning; reconcile before restarting");
    const content = updateEnv(this.content, updates);
    const temporary = `${this.path}.write-${randomUUID()}`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.path);
      const directory = openSync(dirname(this.path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      try { unlinkSync(temporary); } catch { /* Already renamed. */ }
    }
    this.content = content;
    this.values = parse(content);
  }
}

export async function withEnvLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.provision.lock`;
  let fd: number;
  try { fd = openSync(lockPath, "wx", 0o600); }
  catch { throw new OperatorError("Provisioning lock unavailable; check for another process or a stale .env.provision.lock"); }
  try {
    writeFileSync(fd, String(process.pid));
    return await work();
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
}
