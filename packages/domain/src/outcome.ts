export interface MissionOutcome {
  missionId: string; delivered: boolean; reportSha256?: string;
  settlementTxId?: string; failureReason?: string; observedAt: string;
}
