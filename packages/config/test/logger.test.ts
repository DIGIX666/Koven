import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { createLogger, REDACTION_CENSOR } from "../src/index.js";

function captureLogs() {
  let output = "";
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { destination, output: () => output };
}

describe("redacting logger", () => {
  test("redacts signing material and transaction bytes", () => {
    const capture = captureLogs();
    const logger = createLogger({ destination: capture.destination });

    logger.info({
      privateKey: "private-value",
      payment: { signature: "signature-value", transaction: "transaction-value" },
    }, "payment prepared");

    expect(capture.output()).toContain(REDACTION_CENSOR);
    expect(capture.output()).not.toContain("private-value");
    expect(capture.output()).not.toContain("signature-value");
    expect(capture.output()).not.toContain("transaction-value");
  });

  test("redacts private keys stored in child logger bindings", () => {
    const capture = captureLogs();
    const logger = createLogger({ destination: capture.destination })
      .child({ CONSUMER_PRIVATE_KEY: "child-secret", component: "signer" });

    logger.info("ready");

    expect(capture.output()).toContain(REDACTION_CENSOR);
    expect(capture.output()).not.toContain("child-secret");
    expect(capture.output()).toContain("signer");
  });
});
