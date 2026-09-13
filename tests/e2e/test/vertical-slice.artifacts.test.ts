import { describe, it } from "vitest";

import { runVerticalSlice } from "./vertical-slice.js";

// Needs the verified official ZK artifacts from `pnpm zk:build`; runs through `pnpm zk:test`.
describe("keyless vertical integration with real policy proofs", () => {
  it("proves before credit, pays through the zk signer, recovers a lost callback and repays once", async () => {
    await runVerticalSlice({ proofMode: "zk" });
  }, 120_000);
});
