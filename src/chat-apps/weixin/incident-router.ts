import { createHash, randomUUID } from "node:crypto";
import type { ConversationBinding } from "../shared/binding.ts";
import type { Database } from "../../storage/database.ts";
import { inTransaction } from "../../storage/database.ts";
import type { DeliveryStore } from "../../storage/delivery-store.ts";
import type {
  WeixinAccountStore,
  WeixinAuthorizationIncidentSink,
  WeixinInactiveAuthorizationState,
} from "./account-store.ts";

interface IncidentRouterOptions {
  warningRoute(): ConversationBinding | undefined;
  afterWarningPrepared?: (deliveryId: string) => void;
}

interface IncidentRow {
  incident_id: string;
  generation_id: string;
  authorization_state: WeixinInactiveAuthorizationState;
  category: string;
  no_route: number;
}

export class WeixinIncidentRouter implements WeixinAuthorizationIncidentSink {
  constructor(
    private readonly db: Database,
    private readonly accounts: WeixinAccountStore,
    private readonly deliveries: DeliveryStore,
    private readonly options: IncidentRouterOptions,
  ) {}

  async transition(input: {
    generationId: string;
    state: WeixinInactiveAuthorizationState;
    category: string;
  }): Promise<void> {
    inTransaction(this.db, () => {
      const incidentId = `weixin-auth-${randomUUID()}`;
      const transition = this.accounts.latchInactiveInTransaction(
        input.generationId,
        input.state,
        incidentId,
        input.category,
      );
      if (!transition.changed) return;
      this.routeIncident(incidentId, input.state);
    });
  }

  async reconcileUnwarned(): Promise<void> {
    for (const incident of this.accounts.listUnwarnedIncidents()) {
      inTransaction(this.db, () => {
        const row = this.incident(incident.incidentId);
        if (!row) return;
        const route = this.options.warningRoute();
        if (!route) {
          if (row.no_route === 0) this.accounts.markIncidentRouteInTransaction(row.incident_id, { noRoute: true });
          return;
        }
        this.prepareWarning(row.incident_id, row.authorization_state, route);
      });
    }
  }

  private routeIncident(incidentId: string, state: WeixinInactiveAuthorizationState): void {
    const route = this.options.warningRoute();
    if (!route) {
      this.accounts.markIncidentRouteInTransaction(incidentId, { noRoute: true });
      return;
    }
    this.prepareWarning(incidentId, state, route);
  }

  private prepareWarning(
    incidentId: string,
    state: WeixinInactiveAuthorizationState,
    binding: ConversationBinding,
  ): void {
    if (binding.adapterId === "weixin") throw new Error("WeChat authorization warning needs an alternate adapter");
    const deliveryId = `weixin-auth-warning-${createHash("sha256").update(incidentId).digest("hex")}`;
    this.deliveries.prepare({
      id: deliveryId,
      kind: "weixin_authorization_warning",
      binding,
      body: state === "credential_changed"
        ? "[system] WeChat credentials changed; run qiyan-bot weixin-login and restart QiYan"
        : "[system] WeChat authorization expired; run qiyan-bot weixin-login and restart QiYan",
      mandatory: true,
    });
    this.options.afterWarningPrepared?.(deliveryId);
    this.accounts.markIncidentRouteInTransaction(incidentId, { warningDeliveryId: deliveryId });
  }

  private incident(incidentId: string): IncidentRow | undefined {
    return this.db.prepare(`SELECT incident_id, generation_id, authorization_state, category, no_route
      FROM weixin_auth_incidents WHERE incident_id = ? AND warning_delivery_id IS NULL`)
      .get(incidentId) as unknown as IncidentRow | undefined;
  }
}
