import { describe, expect, it } from "vitest";

import { allMissionStates, humanize, missionProgress, missionTone } from "./mission";

describe("mission presentation", () => {
  it("covers every frozen mission state", () => {
    for (const state of allMissionStates) {
      expect(missionTone(state)).toMatch(/^(active|success|warning|danger)$/);
      expect(missionProgress(state)).toBeGreaterThanOrEqual(0);
      expect(missionProgress(state)).toBeLessThanOrEqual(100);
    }
  });

  it("marks terminal outcomes clearly", () => {
    expect(missionTone("closed")).toBe("success");
    expect(missionTone("defaulted")).toBe("danger");
    expect(missionTone("failed")).toBe("danger");
    expect(missionTone("policy-rejected")).toBe("warning");
  });

  it("does not present rejection and recovery as happy-path progress", () => {
    expect(missionProgress("policy-rejected")).toBe(0);
    expect(missionProgress("recovery")).toBe(0);
    expect(missionProgress("closed")).toBe(100);
  });

  it("humanizes protocol identifiers", () => {
    expect(humanize("payment-authorized")).toBe("Payment Authorized");
  });
});

