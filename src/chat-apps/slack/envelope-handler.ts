import { classifySlackEvent, type SlackClassificationContext } from "./event-classifier.ts";
import type { SlackInboxStore } from "./inbox-store.ts";

export interface SlackEventEnvelope {
  body: unknown;
  ack(): Promise<void>;
}

export class SlackEnvelopeHandler {
  constructor(
    private readonly inbox: SlackInboxStore,
    private readonly options: Omit<SlackClassificationContext, "isActivated">,
  ) {}

  async handle(envelope: SlackEventEnvelope): Promise<void> {
    const classified = classifySlackEvent(envelope.body, {
      ...this.options,
      isActivated: (conversationKey) => this.inbox.isActivated(conversationKey),
    });
    if (classified.kind === "accept") this.inbox.accept(classified.event);
    await envelope.ack();
  }
}
