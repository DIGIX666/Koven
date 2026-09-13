import { describe, it } from "vitest";

import { runVerticalSlice } from "./vertical-slice.js";

describe("keyless vertical integration", () => {
  it("runs real HTTP services, recovers a lost callback after restart and repays once", async () => {
    await runVerticalSlice({ proofMode: "deterministic" });
  }, 30_000);
});
