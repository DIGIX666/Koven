import { describe, expect, it } from "vitest";

import { canonicalJsonValue } from "../src/canonical.js";

describe("canonical JSON", () => {
  it("orders object keys by ASCII code point", () => {
    const canonical = canonicalJsonValue({ a: 1, _: 2, Z: 3 });

    expect(Object.keys(canonical as Record<string, unknown>)).toEqual(["Z", "_", "a"]);
  });
});
