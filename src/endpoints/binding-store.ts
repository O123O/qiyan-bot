import { createHash } from "node:crypto";
import { AppError } from "../core/errors.ts";
import type { Database } from "../storage/database.ts";
import { inTransaction } from "../storage/database.ts";

export interface SshDestination { hostname: string; user: string; port: number }

export class EndpointBindingStore {
  constructor(private readonly db: Database) {}

  destinationHash(destination: SshDestination): string {
    return createHash("sha256").update(`${destination.hostname}\0${destination.user}\0${destination.port}`).digest("hex");
  }

  get(endpointId: string): { destinationSha256: string } | undefined {
    const row = this.db.prepare("SELECT destination_sha256 FROM endpoint_bindings WHERE endpoint_id = ?").get(endpointId) as { destination_sha256: string } | undefined;
    return row ? { destinationSha256: row.destination_sha256 } : undefined;
  }

  checkExisting(endpointId: string, destination: SshDestination, hasReferences: boolean): void {
    const existing = this.get(endpointId);
    if (existing && existing.destinationSha256 !== this.destinationHash(destination) && hasReferences) this.changed();
  }

  commitAfterActivation(endpointId: string, destination: SshDestination, hasReferences: boolean): void {
    inTransaction(this.db, () => {
      this.checkExisting(endpointId, destination, hasReferences);
      const digest = this.destinationHash(destination);
      this.db.prepare(`INSERT INTO endpoint_bindings(endpoint_id, destination_sha256, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(endpoint_id) DO UPDATE SET destination_sha256 = excluded.destination_sha256, updated_at = excluded.updated_at`)
        .run(endpointId, digest, Date.now());
    });
  }

  private changed(): never {
    throw new AppError("ENDPOINT_IDENTITY_CHANGED", "SSH endpoint destination identity changed while it is still referenced");
  }
}
