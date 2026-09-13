import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CIRCUIT_ID, verificationKeyHash } from "./bundle.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_MANIFEST_PATH = join(packageRoot, "artifacts-manifest.json");
export const DEFAULT_ARTIFACT_DIRECTORY = join(packageRoot, "artifacts", "official", CIRCUIT_ID);

interface ManifestEntry { readonly file: string; readonly sha256: string }
interface Manifest {
  readonly circuitId: string;
  readonly vkeyHash: string;
  readonly artifacts: { readonly wasm: ManifestEntry; readonly zkey: ManifestEntry; readonly verificationKey: ManifestEntry };
}

export interface ProverArtifacts {
  readonly wasmPath: string;
  readonly zkeyPath: string;
  readonly verificationKey: object;
  /** SHA-256 of the exact `verification_key.json` bytes, equal to the manifest pin. */
  readonly vkeyHash: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isEntry = (value: unknown): value is ManifestEntry => isRecord(value)
  && typeof value.file === "string" && /^[A-Za-z0-9._-]+$/.test(value.file)
  && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256);

function readManifest(path: string): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(parsed) || parsed.circuitId !== CIRCUIT_ID
    || typeof parsed.vkeyHash !== "string" || !/^[0-9a-f]{64}$/.test(parsed.vkeyHash)
    || !isRecord(parsed.artifacts)
    || !isEntry(parsed.artifacts.wasm) || !isEntry(parsed.artifacts.zkey) || !isEntry(parsed.artifacts.verificationKey)
    || parsed.artifacts.verificationKey.sha256 !== parsed.vkeyHash
  ) throw new Error(`Artifact manifest at ${path} is not a valid ${CIRCUIT_ID} manifest`);
  return parsed as unknown as Manifest;
}

function verifiedFile(directory: string, entry: ManifestEntry): { path: string; bytes: Buffer } {
  const path = resolve(directory, entry.file);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error(`Official artifact ${entry.file} is missing; run pnpm zk:build`);
  }
  if (verificationKeyHash(bytes) !== entry.sha256) throw new Error(`Official artifact ${entry.file} does not match the manifest hash`);
  return { path, bytes };
}

/**
 * Loads the official proving and verification artifacts and checks every file
 * against the committed manifest before use. Never downloads or regenerates
 * anything: `pnpm zk:build` owns that, and a mismatch is a hard failure.
 */
export function loadOfficialArtifacts(
  directory: string = DEFAULT_ARTIFACT_DIRECTORY,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): ProverArtifacts {
  const manifest = readManifest(manifestPath);
  const wasm = verifiedFile(directory, manifest.artifacts.wasm);
  const zkey = verifiedFile(directory, manifest.artifacts.zkey);
  const vkey = verifiedFile(directory, manifest.artifacts.verificationKey);
  const verificationKey: unknown = JSON.parse(vkey.bytes.toString("utf8"));
  if (!isRecord(verificationKey) || verificationKey.protocol !== "groth16" || verificationKey.curve !== "bn128") {
    throw new Error("Official verification key is not a Groth16 BN254 key");
  }
  return { wasmPath: wasm.path, zkeyPath: zkey.path, verificationKey, vkeyHash: manifest.vkeyHash };
}

/** Reads and hashes a verification key file a service pinned in its own configuration. */
export function loadPinnedVerificationKey(path: string, expectedSha256: string): { verificationKey: object; vkeyHash: string } {
  const bytes = readFileSync(path);
  const vkeyHash = verificationKeyHash(bytes);
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || vkeyHash !== expectedSha256) {
    throw new Error("Verification key file does not match the pinned hash");
  }
  const verificationKey: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(verificationKey)) throw new Error("Verification key file is not a JSON object");
  return { verificationKey, vkeyHash };
}
