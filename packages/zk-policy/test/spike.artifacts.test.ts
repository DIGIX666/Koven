import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { groth16, wtns } from "snarkjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactDirectory = resolve(
  process.env.ZK_ARTIFACTS_DIR ??
    join(packageRoot, "artifacts", "official", "koven-policy-v1"),
);
const r1csPath = join(artifactDirectory, "policy.r1cs");
const wasmPath = join(artifactDirectory, "policy.wasm");
const zkeyPath = join(artifactDirectory, "policy_final.zkey");
const verificationKeyPath = join(artifactDirectory, "verification_key.json");
const snarkjsPath = join(
  packageRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "snarkjs.CMD" : "snarkjs",
);

const INPUT: Record<string, unknown> = {
  amount: "1000000",
  recipient:
    "20090861577258363490916040138716814650710442748919609827874183591023274269588",
  nonce: "42",
  resourceHash:
    "288031094563920303787641087997950259670691594399068952779151024896538021857",
  cap: "2000000",
  pathElements: [
    "14073517036565120802553032971283289133978697569878094600948169687927784805300",
    "10286088900531720834682469590504728414213434178091464684571742402538694044897",
    "14591368875189789628836098815252747228189821803919503374060259940612771979119",
  ],
  pathIndices: [0, 0, 0],
};

const EXPECTED_PUBLIC_SIGNALS = [
  "1026350485950336119746959985882780800617574155133227942712398221216121187747",
  "9290366279921276004309573535909951682127199613521183526684654559243443935582",
  "2000000",
] as const;

const SAMPLE_COUNT = 10;

interface Summary {
  median: number;
  min: number;
  max: number;
}

let benchmarkDirectory: string;
let constraintCount: number;
let signerVerificationKey: unknown;
let lenderVerificationKey: unknown;

function summarize(values: number[]): Summary {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
  return {
    median: Number(median.toFixed(3)),
    min: Number(sorted[0]!.toFixed(3)),
    max: Number(sorted.at(-1)!.toFixed(3)),
  };
}

async function measure<T>(operation: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await operation();
  return [result, performance.now() - start];
}

beforeAll(() => {
  for (const path of [r1csPath, wasmPath, zkeyPath, verificationKeyPath]) {
    if (!existsSync(path)) {
      throw new Error(
        `Missing official artifact ${path}; run pnpm zk:build before the benchmark`,
      );
    }
  }

  const r1csInfo = execFileSync(snarkjsPath, ["r1cs", "info", r1csPath], {
    encoding: "utf8",
  });
  const constraintMatch = /# of Constraints:\s+(\d+)/u.exec(r1csInfo);
  if (constraintMatch?.[1] === undefined) {
    throw new Error("Unable to read the circuit constraint count");
  }

  constraintCount = Number(constraintMatch[1]);
  const verificationKeyJson = readFileSync(verificationKeyPath, "utf8");
  signerVerificationKey = JSON.parse(verificationKeyJson) as unknown;
  lenderVerificationKey = JSON.parse(verificationKeyJson) as unknown;
  benchmarkDirectory = mkdtempSync(join(tmpdir(), "koven-policy-spike-"));
});

afterAll(() => {
  if (benchmarkDirectory !== undefined) {
    rmSync(benchmarkDirectory, { recursive: true, force: true });
  }
});

describe("Policy V1 feasibility measurements", () => {
  it("measures witness construction, proving and independent verification", async () => {
    expect(constraintCount).toBe(1714);

    const warmup = await groth16.fullProve(INPUT, wasmPath, zkeyPath);
    expect(warmup.publicSignals).toEqual([...EXPECTED_PUBLIC_SIGNALS]);
    await expect(
      groth16.verify(
        signerVerificationKey,
        warmup.publicSignals,
        warmup.proof,
      ),
    ).resolves.toBe(true);
    await expect(
      groth16.verify(
        lenderVerificationKey,
        warmup.publicSignals,
        warmup.proof,
      ),
    ).resolves.toBe(true);
    const alteredPublicSignals = [...warmup.publicSignals];
    alteredPublicSignals[2] = "2000001";
    await expect(
      groth16.verify(
        signerVerificationKey,
        alteredPublicSignals,
        warmup.proof,
      ),
    ).resolves.toBe(false);
    await expect(
      groth16.verify(
        lenderVerificationKey,
        alteredPublicSignals,
        warmup.proof,
      ),
    ).resolves.toBe(false);

    const witnessMilliseconds: number[] = [];
    const provingMilliseconds: number[] = [];
    const signerVerificationMilliseconds: number[] = [];
    const lenderVerificationMilliseconds: number[] = [];
    const proofBytes: number[] = [];

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const witnessPath = join(benchmarkDirectory, `witness-${index}.wtns`);
      const [, witnessDuration] = await measure(() =>
        wtns.calculate(INPUT, wasmPath, witnessPath),
      );
      witnessMilliseconds.push(witnessDuration);

      const [{ proof, publicSignals }, provingDuration] = await measure(() =>
        groth16.prove(zkeyPath, witnessPath),
      );
      provingMilliseconds.push(provingDuration);
      expect(publicSignals).toEqual([...EXPECTED_PUBLIC_SIGNALS]);

      const [signerAccepted, signerDuration] = await measure(() =>
        groth16.verify(signerVerificationKey, publicSignals, proof),
      );
      const [lenderAccepted, lenderDuration] = await measure(() =>
        groth16.verify(lenderVerificationKey, publicSignals, proof),
      );
      expect(signerAccepted).toBe(true);
      expect(lenderAccepted).toBe(true);
      signerVerificationMilliseconds.push(signerDuration);
      lenderVerificationMilliseconds.push(lenderDuration);
      proofBytes.push(Buffer.byteLength(JSON.stringify(proof), "utf8"));
    }

    const measurements = {
      samples: SAMPLE_COUNT,
      constraints: constraintCount,
      publicSignals: EXPECTED_PUBLIC_SIGNALS.length,
      witnessConstructionMs: summarize(witnessMilliseconds),
      provingMs: summarize(provingMilliseconds),
      signerVerificationMs: summarize(signerVerificationMilliseconds),
      lenderVerificationMs: summarize(lenderVerificationMilliseconds),
      proofJsonBytes: summarize(proofBytes),
    };

    process.stdout.write(
      `\nPolicy V1 benchmark\n${JSON.stringify(measurements, null, 2)}\n`,
    );

    expect(measurements.publicSignals).toBe(3);
    expect(measurements.proofJsonBytes.min).toBeGreaterThan(0);
  }, 120_000);
});
