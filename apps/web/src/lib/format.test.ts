import { describe, expect, it } from "vitest";

import { compactHash, formatTinybar, hashscanTransactionUrl } from "./format";

describe("dashboard formatting", () => {
  it.each([
    ["0", "0 ℏ"],
    ["1", "0.00000001 ℏ"],
    ["100000000", "1 ℏ"],
    ["123456789", "1.23456789 ℏ"],
    ["2500000000", "25 ℏ"],
  ])("formats %s tinybar exactly", (value, expected) => {
    expect(formatTinybar(value)).toBe(expected);
  });

  it("preserves integers beyond Number.MAX_SAFE_INTEGER", () => {
    expect(formatTinybar("900719925474099300000000"))
      .toBe("9,007,199,254,740,993 ℏ");
  });

  it("compacts hashes but preserves short identifiers", () => {
    expect(compactHash("abcdef")).toBe("abcdef");
    expect(compactHash("a".repeat(64))).toBe("aaaaaaaa…aaaaaa");
  });

  it("encodes a Hedera transaction id in a testnet HashScan URL", () => {
    expect(hashscanTransactionUrl("0.0.123@1.2"))
      .toBe("https://hashscan.io/testnet/transaction/0.0.123%401.2");
  });
});

