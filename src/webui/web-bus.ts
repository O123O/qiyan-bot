import type { WebSocket } from "ws";

// Shared broadcast bus between the `web` ChatAdapter (which pushes assistant replies) and the
// web HTTP/WS server (which pushes dashboard changes and owns the browser sockets). Created
// early so both the adapter and the server can reference the same instance.
export type WebEvent =
  | { type: "message"; body: string; at: number }
  | { type: "sessions"; sessions: unknown[]; at: number };

export class WebBus {
  private readonly sockets = new Set<WebSocket>();

  add(socket: WebSocket): void { this.sockets.add(socket); }
  remove(socket: WebSocket): void { this.sockets.delete(socket); }
  get size(): number { return this.sockets.size; }

  broadcast(event: WebEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.sockets) {
      // readyState 1 === OPEN; skip anything mid-close so a dead socket never throws.
      if (socket.readyState === 1) { try { socket.send(payload); } catch { /* drop on a broken socket */ } }
    }
  }
}
