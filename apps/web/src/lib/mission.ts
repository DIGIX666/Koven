import { MISSION_STATES, type MissionState } from "@koven/domain";

const ACTIVE_STATES = new Set<MissionState>([
  "created",
  "discovering-services",
  "credit-requested",
  "funded",
  "payment-preparation",
  "payment-authorized",
  "service-paid",
  "running",
  "completed",
  "repayment-pending",
  "repaid",
]);

export function missionTone(state: MissionState): "active" | "success" | "warning" | "danger" {
  if (state === "closed") return "success";
  if (state === "policy-rejected" || state === "recovery") return "warning";
  if (state === "failed" || state === "defaulted") return "danger";
  return "active";
}

export function missionProgress(state: MissionState): number {
  if (state === "closed") return 100;
  if (!ACTIVE_STATES.has(state)) return 0;
  const happyPath: MissionState[] = [
    "created",
    "discovering-services",
    "credit-requested",
    "funded",
    "payment-preparation",
    "payment-authorized",
    "service-paid",
    "running",
    "completed",
    "repayment-pending",
    "repaid",
    "closed",
  ];
  const index = happyPath.indexOf(state);
  return index < 0 ? 0 : Math.round((index / (happyPath.length - 1)) * 100);
}

export function humanize(value: string): string {
  return value.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export const allMissionStates = MISSION_STATES;

