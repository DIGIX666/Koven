import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../..");
const circuitPath = join(packageRoot, "circuits", "policy.circom");
const merklePath = join(packageRoot, "circuits", "merkle.circom");
const libraryPath = join(packageRoot, "node_modules");
const packageJsonPath = join(packageRoot, "package.json");
const defaultManifestPath = join(packageRoot, "artifacts-manifest.json");
const snarkjsPath = join(
  packageRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "snarkjs.CMD" : "snarkjs",
);

const CIRCUIT_ID = "koven-policy-v1";
const CIRCOM_VERSION = "2.2.3";
const COMPILER_FLAGS = ["--r1cs", "--wasm", "--sym", "--O2"] as const;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const ARTIFACT_FILES = {
  r1cs: "policy.r1cs",
  wasm: "policy.wasm",
  zkey: "policy_final.zkey",
  verificationKey: "verification_key.json",
  phase2Transcript: "phase2-transcript.txt",
} as const;
const PTAU = {
  file: "ppot_0080_12.ptau",
  points: 4096,
  sha256: "35e163120e724a60853d0dd76ec54037f7c7b00584392255f71a4341d5a05c50",
  url: "https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_12.ptau",
} as const;

interface ArtifactRecord {
  file: string;
  sha256: string;
  url: string;
}

interface ArtifactManifest {
  schemaVersion: 1;
  circuitId: string;
  sourceRevision: string;
  sourceHashes: {
    policyCircom: string;
    merkleCircom: string;
  };
  compiler: {
    name: "circom";
    version: string;
    flags: string[];
  };
  libraries: {
    circomlib: string;
    snarkjs: string;
  };
  phase1: typeof PTAU;
  artifacts: {
    r1cs: ArtifactRecord;
    wasm: ArtifactRecord;
    zkey: ArtifactRecord;
    verificationKey: ArtifactRecord;
    phase2Transcript: ArtifactRecord;
  };
  vkeyHash: string;
}

interface CliOptions {
  command: "build" | "setup-release";
  manifestPath: string;
  outputPath?: string;
  releaseBaseUrl?: string;
  contributor?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stripAnsi(value: string): string {
  const escape = String.fromCodePoint(27);
  return value.replaceAll(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "gu"), "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    ...(input === undefined ? {} : { input }),
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error !== undefined) {
    fail(`Unable to run ${basename(command)}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${basename(command)} failed:\n${stripAnsi(output).trim()}`);
  }
  return stripAnsi(output).trim();
}

export function assertCircomVersion(actualVersion: string): void {
  if (actualVersion.trim() !== `circom compiler ${CIRCOM_VERSION}`) {
    fail(`Expected Circom ${CIRCOM_VERSION}, received: ${actualVersion.trim()}`);
  }
}

function installedPackageVersion(packageName: string): string | undefined {
  const dependencyPackageJson = JSON.parse(
    readFileSync(join(packageRoot, "node_modules", packageName, "package.json"), "utf8"),
  ) as { version?: string };
  return dependencyPackageJson.version;
}

function assertToolVersions(): void {
  assertCircomVersion(run("circom", ["--version"]));

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const snarkjsVersion = packageJson.devDependencies?.snarkjs;
  const circomlibVersion = packageJson.devDependencies?.circomlib;
  if (
    snarkjsVersion !== "0.7.6" ||
    circomlibVersion !== "2.0.5" ||
    installedPackageVersion("snarkjs") !== "0.7.6" ||
    installedPackageVersion("circomlib") !== "2.0.5"
  ) {
    fail("The ZK build requires pinned snarkjs 0.7.6 and circomlib 2.0.5");
  }
}

function compileCircuit(outputPath: string): void {
  run("circom", [
    circuitPath,
    ...COMPILER_FLAGS,
    "--output",
    outputPath,
    "-l",
    libraryPath,
  ]);
}

export async function downloadVerified(
  record: ArtifactRecord,
  destination: string,
): Promise<void> {
  const url = new URL(record.url);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    fail(`Artifact URL must use HTTPS without credentials: ${record.url}`);
  }

  if (existsSync(destination)) {
    const actual = sha256(destination);
    if (actual !== record.sha256) {
      fail(
        `Refusing to replace ${destination}: expected ${record.sha256}, received ${actual}`,
      );
    }
    return;
  }

  const temporaryPath = `${destination}.part-${process.pid}`;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      fail(`Unable to download ${record.url}: HTTP ${response.status}`);
    }
    if (response.url !== "" && new URL(response.url).protocol !== "https:") {
      fail(`Artifact redirect must use HTTPS: ${response.url}`);
    }

    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(temporaryPath, Buffer.from(await response.arrayBuffer()), {
      flag: "wx",
    });
    const actual = sha256(temporaryPath);
    if (actual !== record.sha256) {
      fail(`Hash mismatch for ${record.file}: expected ${record.sha256}, received ${actual}`);
    }
    renameSync(temporaryPath, destination);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function parseManifest(path: string): ArtifactManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`Unable to parse artifact manifest at ${path}: ${reason}`);
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.compiler) ||
    !isRecord(parsed.libraries) ||
    !isRecord(parsed.phase1) ||
    !isRecord(parsed.sourceHashes) ||
    !isRecord(parsed.artifacts)
  ) {
    fail(`Invalid artifact manifest structure at ${path}`);
  }
  const manifest = parsed as unknown as ArtifactManifest;
  if (manifest.schemaVersion !== 1 || manifest.circuitId !== CIRCUIT_ID) {
    fail(`Unsupported artifact manifest at ${path}`);
  }
  if (
    manifest.compiler.name !== "circom" ||
    manifest.compiler.version !== CIRCOM_VERSION ||
    manifest.libraries.circomlib !== "2.0.5" ||
    manifest.libraries.snarkjs !== "0.7.6"
  ) {
    fail("Artifact manifest tool versions do not match the pinned build");
  }
  if (
    !Array.isArray(manifest.compiler.flags) ||
    manifest.compiler.flags.length !== COMPILER_FLAGS.length ||
    !manifest.compiler.flags.every((flag, index) => flag === COMPILER_FLAGS[index])
  ) {
    fail("Artifact manifest compiler flags do not match the pinned build");
  }
  if (
    manifest.phase1.file !== PTAU.file ||
    manifest.phase1.sha256 !== PTAU.sha256 ||
    manifest.phase1.url !== PTAU.url ||
    manifest.phase1.points !== PTAU.points
  ) {
    fail("Artifact manifest does not pin the reviewed Powers of Tau transcript");
  }
  if (
    !/^[a-f0-9]{40}$/u.test(manifest.sourceRevision) ||
    !/^[a-f0-9]{64}$/u.test(manifest.sourceHashes.policyCircom) ||
    !/^[a-f0-9]{64}$/u.test(manifest.sourceHashes.merkleCircom) ||
    manifest.sourceHashes.policyCircom !== sha256(circuitPath) ||
    manifest.sourceHashes.merkleCircom !== sha256(merklePath)
  ) {
    fail("Circuit sources do not match the reviewed artifact manifest");
  }
  const artifactKeys = Object.keys(manifest.artifacts).sort();
  const expectedArtifactKeys = Object.keys(ARTIFACT_FILES).sort();
  if (artifactKeys.join("\n") !== expectedArtifactKeys.join("\n")) {
    fail("Artifact manifest does not contain the exact required artifact roles");
  }
  for (const [role, expectedFile] of Object.entries(ARTIFACT_FILES)) {
    const record = manifest.artifacts[role as keyof ArtifactManifest["artifacts"]];
    if (!isRecord(record)) {
      fail(`Artifact manifest contains an invalid record for ${role}`);
    }
    if (record.file !== expectedFile) {
      fail(`Artifact manifest contains an unexpected filename for ${role}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(record.sha256)) {
      fail(`Artifact manifest contains an invalid hash for ${record.file}`);
    }
    let artifactUrl: URL;
    try {
      artifactUrl = new URL(record.url);
    } catch {
      fail(`Artifact manifest contains an invalid URL for ${record.file}`);
    }
    if (
      artifactUrl.protocol !== "https:" ||
      artifactUrl.username !== "" ||
      artifactUrl.password !== "" ||
      decodeURIComponent(basename(artifactUrl.pathname)) !== record.file
    ) {
      fail(`Artifact manifest contains an unsafe URL for ${record.file}`);
    }
  }
  if (
    !/^[a-f0-9]{64}$/u.test(manifest.vkeyHash) ||
    manifest.vkeyHash !== manifest.artifacts.verificationKey.sha256
  ) {
    fail("Artifact manifest contains an invalid verification-key hash");
  }
  return manifest;
}

function assertCircuitSourcesCommitted(): void {
  const status = run("git", [
    "status",
    "--short",
    "--untracked-files=all",
    "--",
    "packages/zk-policy/circuits/policy.circom",
    "packages/zk-policy/circuits/merkle.circom",
  ]);
  if (status !== "") {
    fail("Commit the exact circuit sources before creating release artifacts");
  }
}

async function verifyOfficialBuild(manifestPath: string): Promise<void> {
  assertToolVersions();
  const manifest = parseManifest(manifestPath);
  const temporaryBuild = mkdtempSync(join(tmpdir(), "koven-zk-build-"));
  const artifactDirectory = resolve(
    process.env.ZK_ARTIFACTS_DIR ??
      join(packageRoot, "artifacts", "official", manifest.circuitId),
  );

  try {
    compileCircuit(temporaryBuild);
    const compiledR1cs = join(temporaryBuild, "policy.r1cs");
    const compiledWasm = join(temporaryBuild, "policy_js", "policy.wasm");
    if (sha256(compiledR1cs) !== manifest.artifacts.r1cs.sha256) {
      fail("Compiled R1CS does not match the official artifact");
    }
    if (sha256(compiledWasm) !== manifest.artifacts.wasm.sha256) {
      fail("Compiled WASM does not match the official artifact");
    }

    const records = Object.values(manifest.artifacts);
    await Promise.all(
      records.map((record) =>
        downloadVerified(record, join(artifactDirectory, record.file)),
      ),
    );
    await downloadVerified(PTAU, join(artifactDirectory, PTAU.file));

    const r1csPath = join(artifactDirectory, manifest.artifacts.r1cs.file);
    const zkeyPath = join(artifactDirectory, manifest.artifacts.zkey.file);
    const ptauPath = join(artifactDirectory, PTAU.file);
    run(snarkjsPath, ["zkey", "verify", r1csPath, ptauPath, zkeyPath]);

    const exportedVkey = join(temporaryBuild, "verification_key.json");
    run(snarkjsPath, ["zkey", "export", "verificationkey", zkeyPath, exportedVkey]);
    const officialVkey = join(
      artifactDirectory,
      manifest.artifacts.verificationKey.file,
    );
    if (sha256(exportedVkey) !== sha256(officialVkey)) {
      fail("The zkey exports a verification key different from the official file");
    }
    if (sha256(officialVkey) !== manifest.vkeyHash) {
      fail("The verification-key bytes do not match the manifest vkeyHash");
    }

    process.stdout.write(
      `Verified ${manifest.circuitId} (${manifest.vkeyHash}) in ${artifactDirectory}\n`,
    );
  } finally {
    rmSync(temporaryBuild, { recursive: true, force: true });
  }
}

function artifactRecord(
  releaseBaseUrl: string,
  path: string,
): ArtifactRecord {
  return {
    file: basename(path),
    sha256: sha256(path),
    url: `${releaseBaseUrl}/${basename(path)}`,
  };
}

async function setupRelease(options: CliOptions): Promise<void> {
  assertToolVersions();
  assertCircuitSourcesCommitted();
  if (options.outputPath === undefined || options.releaseBaseUrl === undefined) {
    fail("setup-release requires --output and --release-base-url");
  }
  const releaseUrl = new URL(options.releaseBaseUrl);
  if (
    releaseUrl.protocol !== "https:" ||
    releaseUrl.username !== "" ||
    releaseUrl.password !== "" ||
    releaseUrl.search !== "" ||
    releaseUrl.hash !== ""
  ) {
    fail("The release base URL must be an HTTPS URL without credentials, query or hash");
  }
  const contributionName = options.contributor ?? "Koven Policy V1 maintainer";
  const containsControlCharacter = [...contributionName].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (
    contributionName.trim() === "" ||
    Buffer.byteLength(contributionName, "utf8") > 64 ||
    containsControlCharacter
  ) {
    fail("Contributor name must be 1-64 UTF-8 bytes without control characters");
  }
  const sourceRevision = run("git", ["rev-parse", "HEAD"]);

  const outputPath = resolve(options.outputPath);
  if (existsSync(outputPath)) {
    fail(`Refusing to overwrite existing release directory: ${outputPath}`);
  }
  mkdirSync(outputPath, { recursive: true });

  const temporaryBuild = mkdtempSync(join(tmpdir(), "koven-zk-release-"));
  const ptauCache = join(packageRoot, "artifacts", "cache", PTAU.file);
  const initialZkey = join(temporaryBuild, "policy_0000.zkey");
  const finalZkey = join(outputPath, "policy_final.zkey");
  const r1csPath = join(outputPath, "policy.r1cs");
  const wasmPath = join(outputPath, "policy.wasm");
  const verificationKeyPath = join(outputPath, "verification_key.json");
  const transcriptPath = join(outputPath, "phase2-transcript.txt");

  try {
    await downloadVerified(PTAU, ptauCache);
    const phase1Verification = run(snarkjsPath, [
      "powersoftau",
      "verify",
      ptauCache,
    ]);
    compileCircuit(temporaryBuild);
    copyFileSync(join(temporaryBuild, "policy.r1cs"), r1csPath);
    copyFileSync(join(temporaryBuild, "policy_js", "policy.wasm"), wasmPath);

    const initialSetup = run(snarkjsPath, [
      "groth16",
      "setup",
      r1csPath,
      ptauCache,
      initialZkey,
    ]);
    const contributionEntropy = randomBytes(64).toString("hex");
    const contribution = run(snarkjsPath, [
      "zkey",
      "contribute",
      initialZkey,
      finalZkey,
      `--name=${contributionName}`,
      "--verbose",
    ], `${contributionEntropy}\n`);
    const zkeyVerification = run(snarkjsPath, [
      "zkey",
      "verify",
      r1csPath,
      ptauCache,
      finalZkey,
    ]);
    run(snarkjsPath, [
      "zkey",
      "export",
      "verificationkey",
      finalZkey,
      verificationKeyPath,
    ]);

    assertCircuitSourcesCommitted();
    if (run("git", ["rev-parse", "HEAD"]) !== sourceRevision) {
      fail("Repository HEAD changed while release artifacts were being created");
    }
    const transcript = [
      `Circuit: ${CIRCUIT_ID}`,
      `Source revision: ${sourceRevision}`,
      `Contributor: ${contributionName}`,
      "",
      "Powers of Tau verification",
      phase1Verification,
      "",
      "Initial Groth16 setup",
      initialSetup,
      "",
      "Phase 2 contribution",
      contribution,
      "",
      "Final zkey verification",
      zkeyVerification,
      "",
    ].join("\n");
    writeFileSync(transcriptPath, transcript, { flag: "wx" });

    const baseUrl = options.releaseBaseUrl.replace(/\/$/u, "");
    const manifest: ArtifactManifest = {
      schemaVersion: 1,
      circuitId: CIRCUIT_ID,
      sourceRevision,
      sourceHashes: {
        policyCircom: sha256(circuitPath),
        merkleCircom: sha256(merklePath),
      },
      compiler: {
        name: "circom",
        version: CIRCOM_VERSION,
        flags: [...COMPILER_FLAGS],
      },
      libraries: { circomlib: "2.0.5", snarkjs: "0.7.6" },
      phase1: PTAU,
      artifacts: {
        r1cs: artifactRecord(baseUrl, r1csPath),
        wasm: artifactRecord(baseUrl, wasmPath),
        zkey: artifactRecord(baseUrl, finalZkey),
        verificationKey: artifactRecord(baseUrl, verificationKeyPath),
        phase2Transcript: artifactRecord(baseUrl, transcriptPath),
      },
      vkeyHash: sha256(verificationKeyPath),
    };
    writeFileSync(
      join(outputPath, "artifacts-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    process.stdout.write(
      `Release bundle created in ${outputPath}\nVerification key hash: ${manifest.vkeyHash}\n`,
    );
  } catch (error) {
    rmSync(outputPath, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(temporaryBuild, { recursive: true, force: true });
  }
}

export function parseCli(argv: string[]): CliOptions {
  const command = argv[0];
  if (command !== "build" && command !== "setup-release") {
    fail("Usage: build.ts <build|setup-release> [options]");
  }
  const allowedOptions =
    command === "build"
      ? new Set(["--manifest"])
      : new Set(["--output", "--release-base-url", "--contributor"]);
  const values = new Map<string, string>();
  const firstOptionIndex = argv[1] === "--" ? 2 : 1;
  for (let index = firstOptionIndex; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      fail(`Invalid command option near ${key ?? "end of input"}`);
    }
    if (!allowedOptions.has(key)) {
      fail(`Unsupported option ${key} for ${command}`);
    }
    if (values.has(key)) {
      fail(`Duplicate command option ${key}`);
    }
    values.set(key, value);
  }
  return {
    command,
    manifestPath: resolve(values.get("--manifest") ?? defaultManifestPath),
    ...(values.has("--output")
      ? { outputPath: resolve(values.get("--output")!) }
      : {}),
    ...(values.has("--release-base-url")
      ? { releaseBaseUrl: values.get("--release-base-url")! }
      : {}),
    ...(values.has("--contributor")
      ? { contributor: values.get("--contributor")! }
      : {}),
  };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.command === "setup-release") {
    await setupRelease(options);
  } else {
    await verifyOfficialBuild(options.manifestPath);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
