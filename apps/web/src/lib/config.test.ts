import { describe, expect, it } from "vitest";

import { configuredMissionIds } from "./config";

describe("configuredMissionIds", () => {
  it("trims, validates and deduplicates configured ids", () => {
    expect(configuredMissionIds(" mission-1,mission-2,mission-1,../bad,"))
      .toEqual(["mission-1", "mission-2"]);
  });

  it("returns an empty list when no ids are configured", () => {
    expect(configuredMissionIds("")).toEqual([]);
  });
});

