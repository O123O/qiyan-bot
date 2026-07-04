import type { WeixinCredentialPublic } from "./credential-store.ts";
import type { Database } from "../storage/database.ts";
import { inTransaction } from "../storage/database.ts";
import { DeliveryStore } from "../storage/delivery-store.ts";

export type WeixinAuthorizationState = "active" | "relogin_required" | "credential_changed";
export type WeixinInactiveAuthorizationState = Exclude<WeixinAuthorizationState, "active">;

export type WeixinActivation = {
  kind: "unchanged" | "new-revision" | "new-generation";
  generationId: string;
};

export interface WeixinAuthTransition {
  changed: boolean;
  incidentId?: string;
}

export interface WeixinAuthIncident {
  incidentId: string;
  generationId: string;
  state: WeixinInactiveAuthorizationState;
  category: string;
  noRoute: boolean;
  createdAt: number;
}

export interface WeixinAuthorizationIncidentSink {
  transition(input: {
    generationId: string;
    state: WeixinInactiveAuthorizationState;
    category: string;
  }): Promise<void>;
}

interface AccountStoreOptions {
  now?: () => number;
  afterOldDeliveryFailed?: (deliveryId: string) => void;
}

interface AccountRow {
  generation_id: string;
  credential_revision_id: string;
  bot_id: string;
  owner_user_id: string;
  authorization_state: WeixinAuthorizationState;
  active: number;
}

export class WeixinAccountStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    private readonly deliveries: DeliveryStore,
    private readonly options: AccountStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  activate(identity: WeixinCredentialPublic): WeixinActivation {
    return inTransaction(this.db, () => {
      const existing = this.db.prepare("SELECT * FROM weixin_account_generations WHERE generation_id = ?")
        .get(identity.accountGenerationId) as AccountRow | undefined;
      if (existing) {
        if (existing.bot_id !== identity.botId || existing.owner_user_id !== identity.ownerUserId) {
          throw new Error("WeChat account generation identity changed unexpectedly");
        }
        if (existing.credential_revision_id === identity.credentialRevisionId) {
          if (existing.authorization_state !== "active") {
            this.retireAuthorizationWarningsInTransaction(identity.accountGenerationId);
            this.db.prepare(`UPDATE weixin_account_generations
              SET authorization_state = 'active', active = 1, retired_at = NULL WHERE generation_id = ?`)
              .run(identity.accountGenerationId);
          }
          return { kind: "unchanged", generationId: identity.accountGenerationId };
        }
        this.retireAuthorizationWarningsInTransaction(identity.accountGenerationId);
        this.db.prepare(`UPDATE weixin_account_generations
          SET credential_revision_id = ?, api_base_url = ?, authorization_state = 'active', active = 1, retired_at = NULL
          WHERE generation_id = ?`)
          .run(identity.credentialRevisionId, identity.apiBaseUrl, identity.accountGenerationId);
        return { kind: "new-revision", generationId: identity.accountGenerationId };
      }

      const oldGenerations = this.db.prepare("SELECT generation_id FROM weixin_account_generations WHERE active = 1")
        .all() as Array<{ generation_id: string }>;
      const oldIds = oldGenerations.map(({ generation_id }) => generation_id);
      if (oldIds.length > 0) {
        const placeholders = oldIds.map(() => "?").join(", ");
        const deliveryRows = this.db.prepare(`SELECT DISTINCT delivery_id FROM weixin_outbound_steps
          WHERE generation_id IN (${placeholders}) ORDER BY delivery_id`).all(...oldIds) as Array<{ delivery_id: string }>;
        for (const oldId of oldIds) this.retireAuthorizationWarningsInTransaction(oldId);
        this.db.prepare(`UPDATE weixin_account_generations SET active = 0, retired_at = ?
          WHERE generation_id IN (${placeholders})`).run(this.now(), ...oldIds);
        this.db.prepare(`UPDATE weixin_inbox SET state = 'fenced', updated_at = ?
          WHERE generation_id IN (${placeholders}) AND state IN ('pending', 'processing', 'retry')`).run(this.now(), ...oldIds);
        for (const { delivery_id: deliveryId } of deliveryRows) {
          this.deliveries.failInTransaction(deliveryId);
          this.options.afterOldDeliveryFailed?.(deliveryId);
        }
        this.db.prepare(`DELETE FROM weixin_outbound_steps WHERE generation_id IN (${placeholders})`).run(...oldIds);
        this.db.prepare("DELETE FROM latest_owner_route WHERE singleton = 1 AND adapter_id = 'weixin'").run();
      }

      const activatedAt = this.now();
      this.db.prepare(`INSERT INTO weixin_account_generations
        (generation_id, credential_revision_id, bot_id, owner_user_id, api_base_url, authorization_state, active, activated_at)
        VALUES (?, ?, ?, ?, ?, 'active', 1, ?)`)
        .run(identity.accountGenerationId, identity.credentialRevisionId, identity.botId, identity.ownerUserId, identity.apiBaseUrl, activatedAt);
      this.db.prepare("INSERT INTO weixin_sync_state(generation_id, cursor) VALUES (?, '')").run(identity.accountGenerationId);
      return { kind: "new-generation", generationId: identity.accountGenerationId };
    });
  }

  prepareAuthenticatedProbe(identity: WeixinCredentialPublic): void {
    const existing = this.db.prepare("SELECT * FROM weixin_account_generations WHERE generation_id = ?")
      .get(identity.accountGenerationId) as AccountRow | undefined;
    if (!existing) {
      this.activate(identity);
      return;
    }
    if (existing.bot_id !== identity.botId || existing.owner_user_id !== identity.ownerUserId) {
      throw new Error("WeChat account generation identity changed unexpectedly");
    }
  }

  authorization(generationId: string): WeixinAuthorizationState {
    const row = this.db.prepare("SELECT authorization_state FROM weixin_account_generations WHERE generation_id = ?")
      .get(generationId) as { authorization_state: WeixinAuthorizationState } | undefined;
    if (!row) throw new Error("WeChat account generation is not active");
    return row.authorization_state;
  }

  requireActive(generationId: string): void {
    const row = this.db.prepare(`SELECT 1 AS present FROM weixin_account_generations
      WHERE generation_id = ? AND active = 1 AND authorization_state = 'active'`).get(generationId);
    if (!row) throw new Error("WeChat account authorization is inactive");
  }

  latchInactive(generationId: string, state: WeixinInactiveAuthorizationState, incidentId: string): boolean {
    return inTransaction(this.db, () => {
      const transition = this.latchInactiveInTransaction(generationId, state, incidentId);
      if (transition.changed) this.markIncidentRouteInTransaction(incidentId, { noRoute: true });
      return transition.changed;
    });
  }

  latchInactiveInTransaction(
    generationId: string,
    state: WeixinInactiveAuthorizationState,
    incidentId: string,
    category: string = state,
  ): WeixinAuthTransition {
    const changed = this.db.prepare(`UPDATE weixin_account_generations SET authorization_state = ?
      WHERE generation_id = ? AND active = 1 AND authorization_state = 'active'`).run(state, generationId).changes;
    if (changed !== 1) return { changed: false };
    this.db.prepare(`INSERT INTO weixin_auth_incidents
      (incident_id, generation_id, authorization_state, category, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(incidentId, generationId, state, category, this.now());
    return { changed: true, incidentId };
  }

  markIncidentRouteInTransaction(
    incidentId: string,
    result: { warningDeliveryId: string } | { noRoute: true },
  ): void {
    const changed = "warningDeliveryId" in result
      ? this.db.prepare(`UPDATE weixin_auth_incidents SET warning_delivery_id = ?, no_route = 0
        WHERE incident_id = ? AND warning_delivery_id IS NULL`).run(result.warningDeliveryId, incidentId).changes
      : this.db.prepare(`UPDATE weixin_auth_incidents SET no_route = 1
        WHERE incident_id = ? AND warning_delivery_id IS NULL AND no_route = 0`).run(incidentId).changes;
    if (changed !== 1) throw new Error("WeChat authorization incident route is unavailable");
  }

  listUnwarnedIncidents(): readonly WeixinAuthIncident[] {
    const rows = this.db.prepare(`SELECT incident.incident_id, incident.generation_id, incident.authorization_state,
        incident.category, incident.no_route, incident.created_at
      FROM weixin_auth_incidents AS incident
      JOIN weixin_account_generations AS account ON account.generation_id = incident.generation_id AND account.active = 1
      WHERE incident.warning_delivery_id IS NULL
      ORDER BY incident.created_at, incident.incident_id`).all() as Array<{
        incident_id: string;
        generation_id: string;
        authorization_state: WeixinInactiveAuthorizationState;
        category: string;
        no_route: number;
        created_at: number;
      }>;
    return rows.map((row) => ({
      incidentId: row.incident_id,
      generationId: row.generation_id,
      state: row.authorization_state,
      category: row.category,
      noRoute: row.no_route === 1,
      createdAt: row.created_at,
    }));
  }

  private retireAuthorizationWarningsInTransaction(generationId: string): void {
    const warnings = this.db.prepare(`SELECT warning_delivery_id FROM weixin_auth_incidents
      WHERE generation_id = ? AND warning_delivery_id IS NOT NULL`).all(generationId) as Array<{ warning_delivery_id: string }>;
    for (const warning of warnings) this.deliveries.failInTransaction(warning.warning_delivery_id);
    this.db.prepare("DELETE FROM weixin_auth_incidents WHERE generation_id = ?").run(generationId);
  }
}
