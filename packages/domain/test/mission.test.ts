import { describe, expect, it } from "vitest";

import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  ErrorCode,
  IllegalStateTransitionError,
  MISSION_STATES,
  type MissionState,
} from "../src/index.js";

describe("mission state transitions", () => {
  it("defines transitions for every mission state", () => {
    expect(Object.keys(ALLOWED_TRANSITIONS)).toEqual([...MISSION_STATES]);
  });

  it("accepts every documented transition", () => {
    for (const from of MISSION_STATES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        expect(() => assertTransition(from, to)).not.toThrow();
      }
    }
  });

  it("rejects every undocumented transition with a stable error code", () => {
    for (const from of MISSION_STATES) {
      const allowedTransitions: readonly MissionState[] = ALLOWED_TRANSITIONS[from];

      for (const to of MISSION_STATES) {
        if (allowedTransitions.includes(to)) {
          continue;
        }

        expect(() => assertTransition(from, to)).toThrow(
          expect.objectContaining({
            name: "IllegalStateTransitionError",
            code: ErrorCode.ILLEGAL_STATE_TRANSITION,
            from,
            to,
          }),
        );
      }
    }
  });

  it("rejects an unknown runtime state with the transition error", () => {
    expect(() => assertTransition("corrupted" as MissionState, "closed")).toThrow(
      expect.objectContaining({
        name: "IllegalStateTransitionError",
        code: ErrorCode.ILLEGAL_STATE_TRANSITION,
        from: "corrupted",
        to: "closed",
      }),
    );
  });

  it.each(["defaulted", "closed"] as const)(
    "treats %s as a terminal state",
    (terminalState) => {
      expect(ALLOWED_TRANSITIONS[terminalState]).toEqual([]);

      for (const to of MISSION_STATES) {
        expect(() => assertTransition(terminalState, to)).toThrow(
          IllegalStateTransitionError,
        );
      }
    },
  );
});
