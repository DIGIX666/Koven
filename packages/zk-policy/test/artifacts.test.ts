import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadVerified, sha256 } from "../scripts/build.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "koven-artifact-test-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("official artifact cache", () => {
  it("accepts a cached artifact only when its exact bytes match", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "policy.r1cs");
    const bytes = Buffer.from("reviewed artifact", "utf8");
    writeFileSync(path, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");

    await expect(
      downloadVerified(
        {
          file: "policy.r1cs",
          sha256: expected,
          url: "https://example.invalid/policy.r1cs",
        },
        path,
      ),
    ).resolves.toBeUndefined();
    expect(sha256(path)).toBe(expected);
  });

  it("refuses to replace a tampered cached artifact", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "policy.r1cs");
    writeFileSync(path, "tampered artifact", "utf8");

    await expect(
      downloadVerified(
        {
          file: "policy.r1cs",
          sha256: "0".repeat(64),
          url: "https://example.invalid/policy.r1cs",
        },
        path,
      ),
    ).rejects.toThrow("Refusing to replace");
  });
});
