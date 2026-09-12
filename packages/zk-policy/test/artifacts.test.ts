import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCircomVersion,
  downloadVerified,
  parseCli,
  parseManifest,
  sha256,
} from "../scripts/build.js";

const temporaryDirectories: string[] = [];
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(packageRoot, "artifacts-manifest.json");

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "koven-artifact-test-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("downloads an artifact only when its bytes match the pinned hash", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "policy.r1cs");
    const bytes = Buffer.from("official artifact", "utf8");
    const expected = createHash("sha256").update(bytes).digest("hex");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await downloadVerified(
      {
        file: "policy.r1cs",
        sha256: expected,
        url: "https://artifacts.example/policy.r1cs",
      },
      path,
    );

    expect(readFileSync(path)).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "follow",
      signal: expect.any(AbortSignal),
    });
  });

  it("removes a partial download when the response hash is wrong", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "policy.r1cs");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("modified artifact", { status: 200 })),
    );

    await expect(
      downloadVerified(
        {
          file: "policy.r1cs",
          sha256: "0".repeat(64),
          url: "https://artifacts.example/policy.r1cs",
        },
        path,
      ),
    ).rejects.toThrow("Hash mismatch");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("fails closed when the artifact endpoint is unavailable", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "policy.r1cs");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    await expect(
      downloadVerified(
        {
          file: "policy.r1cs",
          sha256: "0".repeat(64),
          url: "https://artifacts.example/policy.r1cs",
        },
        path,
      ),
    ).rejects.toThrow("HTTP 503");
    expect(existsSync(path)).toBe(false);
  });

  it("rejects an insecure URL even when matching bytes are cached", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "policy.r1cs");
    const bytes = Buffer.from("official artifact", "utf8");
    writeFileSync(path, bytes);

    await expect(
      downloadVerified(
        {
          file: "policy.r1cs",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          url: "http://artifacts.example/policy.r1cs",
        },
        path,
      ),
    ).rejects.toThrow("HTTPS without credentials");
  });
});

describe("artifact manifest validation", () => {
  it("accepts the reviewed manifest and exact Circom version", () => {
    expect(parseManifest(manifestPath).circuitId).toBe("koven-policy-v1");
    expect(() => assertCircomVersion("circom compiler 2.2.3\n")).not.toThrow();
  });

  it("rejects a version with the pinned version as a prefix", () => {
    expect(() => assertCircomVersion("circom compiler 2.2.30")).toThrow(
      "Expected Circom 2.2.3",
    );
  });

  it("rejects unreviewed compiler flags", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "artifacts-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      compiler: { flags: string[] };
    };
    manifest.compiler.flags.push("--inspect");
    writeFileSync(path, JSON.stringify(manifest));

    expect(() => parseManifest(path)).toThrow("compiler flags");
  });

  it("rejects a verification-key hash inconsistent with its artifact", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "artifacts-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      vkeyHash: string;
    };
    manifest.vkeyHash = "0".repeat(64);
    writeFileSync(path, JSON.stringify(manifest));

    expect(() => parseManifest(path)).toThrow("verification-key hash");
  });

  it("rejects unsafe artifact URLs", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "artifacts-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      artifacts: { r1cs: { url: string } };
    };
    manifest.artifacts.r1cs.url = "http://artifacts.example/policy.r1cs";
    writeFileSync(path, JSON.stringify(manifest));

    expect(() => parseManifest(path)).toThrow("unsafe URL");
  });
});

describe("artifact command line", () => {
  it("accepts pnpm's conventional option separator", () => {
    expect(
      parseCli([
        "setup-release",
        "--",
        "--output",
        "release",
        "--release-base-url",
        "https://artifacts.example/release",
      ]),
    ).toMatchObject({
      command: "setup-release",
      releaseBaseUrl: "https://artifacts.example/release",
    });
  });

  it("rejects options that do not belong to the selected command", () => {
    expect(() => parseCli(["build", "--output", "release"])).toThrow(
      "Unsupported option",
    );
    expect(() =>
      parseCli(["setup-release", "--manifest", "manifest.json"]),
    ).toThrow("Unsupported option");
  });

  it("rejects duplicate options instead of silently replacing them", () => {
    expect(() =>
      parseCli([
        "build",
        "--manifest",
        "first.json",
        "--manifest",
        "second.json",
      ]),
    ).toThrow("Duplicate command option");
  });
});
