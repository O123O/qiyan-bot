export interface ChatDeliveryAdapter {
  sendMessage(destination: string | number, body: string, replyTo?: number): Promise<{ message_id: number }>;
  sendDocument?(destination: string | number, file: {
    stream: AsyncIterable<Uint8Array | string>;
    size: number;
    displayName: string;
    mediaType: string;
    caption?: string;
    replyTo?: number;
  }): Promise<{ message_id: number }>;
}

export interface ChatAdapter {
  readonly delivery: ChatDeliveryAdapter;
  start(): void;
  stop(): Promise<void>;
}
