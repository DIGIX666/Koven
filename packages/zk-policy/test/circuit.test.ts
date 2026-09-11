import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const circuitPath = join(packageRoot, "circuits", "policy.circom");
const libraryPath = join(packageRoot, "node_modules");
const snarkjsPath = join(
  packageRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "snarkjs.CMD" : "snarkjs",
);

const VECTOR = {
  emptyLeaf:
    "14073517036565120802553032971283289133978697569878094600948169687927784805300",
  recipient:
    "20090861577258363490916040138716814650710442748919609827874183591023274269588",
  resourceSha256:
    "a3051313512a544637a506fd964a16e8f1026c1af76eb9de9ed3ccfaaf8fe17d",
  resourceHash:
    "288031094563920303787641087997950259670691594399068952779151024896538021857",
  pathElements: [
    "14073517036565120802553032971283289133978697569878094600948169687927784805300",
    "10286088900531720834682469590504728414213434178091464684571742402538694044897",
    "14591368875189789628836098815252747228189821803919503374060259940612771979119",
  ],
  root:
    "9290366279921276004309573535909951682127199613521183526684654559243443935582",
  commitment:
    "1026350485950336119746959985882780800617574155133227942712398221216121187747",
} as const;

interface CircuitInput {
  amount: string;
  recipient: string;
  nonce: string;
  resourceHash: string;
  cap: string;
  pathElements: string[];
  pathIndices: number[];
}

interface CircuitOutputs {
  commitment: string;
  root: string;
  cap: string;
}

let buildDirectory: string;
let witnessSequence = 0;

function vectorInput(): CircuitInput {
  return {
    amount: "1000000",
    recipient: VECTOR.recipient,
    nonce: "42",
    resourceHash: VECTOR.resourceHash,
    cap: "2000000",
    pathElements: [...VECTOR.pathElements],
    pathIndices: [0, 0, 0],
  };
}

function runWitness(input: CircuitInput): CircuitOutputs {
  const sequence = witnessSequence++;
  const inputPath = join(buildDirectory, `input-${sequence}.json`);
  const witnessPath = join(buildDirectory, `witness-${sequence}.wtns`);
  const witnessJsonPath = join(buildDirectory, `witness-${sequence}.json`);
  const generatorPath = join(
    buildDirectory,
    "policy_js",
    "generate_witness.js",
  );
  const wasmPath = join(buildDirectory, "policy_js", "policy.wasm");

  writeFileSync(inputPath, JSON.stringify(input));
  execFileSync(
    process.execPath,
    [generatorPath, wasmPath, inputPath, witnessPath],
    { stdio: "pipe" },
  );
  execFileSync(
    snarkjsPath,
    ["wtns", "export", "json", witnessPath, witnessJsonPath],
    { stdio: "pipe" },
  );

  const witness = JSON.parse(readFileSync(witnessJsonPath, "utf8")) as string[];
  const commitment = witness[1];
  const root = witness[2];
  const cap = witness[3];
  if (commitment === undefined || root === undefined || cap === undefined) {
    throw new Error("Circuit witness is missing its public outputs");
  }
  return { commitment, root, cap };
}

beforeAll(() => {
  const version = execFileSync("circom", ["--version"], {
    encoding: "utf8",
  });
  expect(version).toContain("2.2.3");

  buildDirectory = mkdtempSync(join(tmpdir(), "koven-policy-circuit-"));
  execFileSync(
    "circom",
    [
      circuitPath,
      "--r1cs",
      "--wasm",
      "--sym",
      "--O2",
      "--output",
      buildDirectory,
      "-l",
      libraryPath,
    ],
    { stdio: "pipe" },
  );

  const info = execFileSync(
    snarkjsPath,
    ["r1cs", "info", join(buildDirectory, "policy.r1cs")],
    { encoding: "utf8" },
  );
  expect(info).toMatch(/# of Constraints:\s+1714/);
  expect(info).toMatch(/# of Outputs:\s+3/);
}, 30_000);

afterAll(() => {
  if (buildDirectory !== undefined) {
    rmSync(buildDirectory, { recursive: true, force: true });
  }
});

describe("Policy V1 circuit", () => {
  it("matches the frozen Poseidon and resource-hash vector", async () => {
    const poseidon = await buildPoseidon();
    const asDecimal = (inputs: readonly bigint[]): string =>
      poseidon.F.toString(poseidon(inputs));

    const recipient = asDecimal([0n, 0n, 10396537n]);
    const emptyLeaf = asDecimal([0n, 0n, 0n, 1n]);
    const emptyPair = asDecimal([BigInt(emptyLeaf), BigInt(emptyLeaf)]);
    const emptyQuarter = asDecimal([BigInt(emptyPair), BigInt(emptyPair)]);
    const firstParent = asDecimal([BigInt(recipient), BigInt(emptyLeaf)]);
    const secondParent = asDecimal([BigInt(firstParent), BigInt(emptyPair)]);
    const root = asDecimal([BigInt(secondParent), BigInt(emptyQuarter)]);

    const canonicalResource = [
      "POST http://127.0.0.1:4401/scan",
      "mission-zk-vector-v1",
      "0".repeat(64),
    ].join("\n");
    const resourceSha256 = createHash("sha256")
      .update(canonicalResource, "utf8")
      .digest("hex");
    const resourceHash = BigInt(`0x${resourceSha256.slice(0, 62)}`).toString();
    const commitment = asDecimal([
      1000000n,
      BigInt(recipient),
      42n,
      BigInt(resourceHash),
    ]);

    expect(emptyLeaf).toBe(VECTOR.emptyLeaf);
    expect(recipient).toBe(VECTOR.recipient);
    expect(resourceSha256).toBe(VECTOR.resourceSha256);
    expect(resourceHash).toBe(VECTOR.resourceHash);
    expect([emptyLeaf, emptyPair, emptyQuarter]).toEqual(VECTOR.pathElements);
    expect(root).toBe(VECTOR.root);
    expect(commitment).toBe(VECTOR.commitment);

    expect(runWitness(vectorInput())).toEqual({
      commitment: VECTOR.commitment,
      root: VECTOR.root,
      cap: "2000000",
    });
  });

  it("rejects an amount above the cap", () => {
    const input = vectorInput();
    input.amount = "2000001";
    expect(() => runWitness(input)).toThrow();
  });

  it("range-checks amount, cap, nonce and resource hash", () => {
    const twoTo64 = (1n << 64n).toString();
    const twoTo248 = (1n << 248n).toString();

    const amount = vectorInput();
    amount.amount = twoTo64;
    amount.cap = twoTo64;
    expect(() => runWitness(amount)).toThrow();

    const cap = vectorInput();
    cap.cap = twoTo64;
    expect(() => runWitness(cap)).toThrow();

    const nonce = vectorInput();
    nonce.nonce = twoTo248;
    expect(() => runWitness(nonce)).toThrow();

    const resourceHash = vectorInput();
    resourceHash.resourceHash = twoTo248;
    expect(() => runWitness(resourceHash)).toThrow();
  });

  it("accepts the inclusive upper bounds of every ranged value", () => {
    const input = vectorInput();
    input.amount = ((1n << 64n) - 1n).toString();
    input.cap = input.amount;
    input.nonce = ((1n << 248n) - 1n).toString();
    input.resourceHash = input.nonce;

    const outputs = runWitness(input);
    expect(outputs.root).toBe(VECTOR.root);
    expect(outputs.cap).toBe(input.cap);
  });

  it("rejects a non-boolean Merkle path index", () => {
    const input = vectorInput();
    input.pathIndices[0] = 2;
    expect(() => runWitness(input)).toThrow();
  });

  it("exposes a different root for an unapproved path", () => {
    const input = vectorInput();
    input.pathElements[0] = (BigInt(input.pathElements[0]!) + 1n).toString();
    const outputs = runWitness(input);

    expect(outputs.root).not.toBe(VECTOR.root);
    expect(outputs.commitment).toBe(VECTOR.commitment);
  });

  it("computes the host-side root for a right-hand real leaf", async () => {
    const poseidon = await buildPoseidon();
    const asDecimal = (inputs: readonly bigint[]): string =>
      poseidon.F.toString(poseidon(inputs));
    const rightRecipient = asDecimal([0n, 0n, 10396538n]);
    const firstParent = asDecimal([
      BigInt(VECTOR.recipient),
      BigInt(rightRecipient),
    ]);
    const secondParent = asDecimal([
      BigInt(firstParent),
      BigInt(VECTOR.pathElements[1]),
    ]);
    const expectedRoot = asDecimal([
      BigInt(secondParent),
      BigInt(VECTOR.pathElements[2]),
    ]);
    const input = vectorInput();
    input.recipient = rightRecipient;
    input.pathElements = [
      VECTOR.recipient,
      VECTOR.pathElements[1],
      VECTOR.pathElements[2],
    ];
    input.pathIndices = [1, 0, 0];

    expect(runWitness(input).root).toBe(expectedRoot);
  });
});
