import {
  prepareTopicMessage,
  reconcileTopicMessage,
  submitPreparedTopicMessage,
  type Client,
} from "@koven/hedera";

import type { HcsPublisher, HcsSubmissionResult, PreparedHcsMessage } from "./writer.js";

/** Prepares signed, replayable HCS bytes and reconciles only the persisted ID. */
export class HederaHcsPublisher implements HcsPublisher {
  constructor(private readonly client: Client, private readonly topicId: string) {}

  async prepare(message: string): Promise<PreparedHcsMessage> {
    return prepareTopicMessage(this.client, this.topicId, message);
  }

  async submit(transactionBase64: string): Promise<HcsSubmissionResult> {
    return submitPreparedTopicMessage(this.client, transactionBase64);
  }

  async reconcile(transactionId: string): Promise<HcsSubmissionResult> {
    return reconcileTopicMessage(this.client, transactionId);
  }
}
