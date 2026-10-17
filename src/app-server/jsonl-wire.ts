import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { endpointLossError } from "../endpoints/types.ts";
import type { RpcWire } from "./rpc-client.ts";

export class JsonlWire implements RpcWire {
  private readonly messages = new Set<(message: string) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  private closed = false;

  constructor(input: Readable, private readonly output: Writable) {
    const lines = createInterface({ input });
    lines.on("line", (line) => { for (const listener of this.messages) listener(line); });
    lines.on("error", (error) => this.emitClose(error));
    input.on("error", (error) => this.emitClose(error));
    // A healthy app-server has no reason to close the stream it serves us on, and this fires
    // BEFORE the child's own `exit` event -- which is why tagging that exit handler instead left
    // every local app-server death classified as an unknown transport fault.
    input.on("end", () => this.emitClose(endpointLossError("runtime_exited", "app-server stream ended")));
    input.on("close", () => this.emitClose(endpointLossError("runtime_exited", "app-server stream closed")));
  }

  send(message: string): void { this.output.write(`${message}\n`); }
  close(): void { this.emitClose(); }
  onMessage(listener: (message: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }

  private emitClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener(error);
  }
}
