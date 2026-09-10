import { openDatabase, reserveSpending } from "../src/index.js";

const [databasePath, startAtText, nonce, paymentCommitment, timestamp] = process.argv.slice(2);
if (!databasePath || !startAtText || !nonce || !paymentCommitment || !timestamp) {
  throw new Error("Missing reservation worker arguments");
}

const database = openDatabase(databasePath);
const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const delay = Number(startAtText) - Date.now();
if (delay > 0) Atomics.wait(waitBuffer, 0, 0, delay);

try {
  reserveSpending(database, {
    missionId: "mission-1",
    nonce,
    paymentCommitment,
    amountTinybar: 60n,
    consumedAt: timestamp,
  });
  process.stdout.write(JSON.stringify({ outcome: "ok" }));
} catch (error) {
  const outcome = error instanceof Error && "conflict" in error
    ? String(error.conflict)
    : error instanceof Error ? error.name : "unknown_error";
  process.stdout.write(JSON.stringify({ outcome }));
} finally {
  database.close();
}
