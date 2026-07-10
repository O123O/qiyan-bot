import assert from "node:assert/strict";
import test from "node:test";
import { assistantAuthenticationStartupError, recordAssistantAuthenticationFailure } from "../../src/assistant/auth-recovery.ts";
import { EndpointAuthenticationRequiredError } from "../../src/app-server/managed-endpoint.ts";
import { AppError } from "../../src/core/errors.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

const binding = { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } } as const;

test("assistant authentication warnings deduplicate within an incident", () => {
  const deliveries = new DeliveryStore(createTestDatabase());
  let route = binding;
  recordAssistantAuthenticationFailure(deliveries, () => route, 3);
  recordAssistantAuthenticationFailure(deliveries, () => route, 3);
  route = { adapterId: "slack", conversationKey: "slack:D1", destination: { channelId: "D1" } } as any;
  recordAssistantAuthenticationFailure(deliveries, () => route, 4);
  const ready = deliveries.listReady();
  assert.deepEqual(ready.map((row) => row.id), ["assistant-auth-required:3", "assistant-auth-required:4"]);
  assert.ok(ready.every((row) => row.kind === "system_warning" && row.mandatory));
  assert.ok(ready.every((row) => row.body.includes("qiyan-bot assistant-login")));
  assert.equal(ready[0]?.binding.adapterId, "telegram");
  assert.equal(ready[1]?.binding.adapterId, "slack");
});

test("cold-start authentication failure gives the operator an actionable login command", () => {
  const mapped = assistantAuthenticationStartupError(new EndpointAuthenticationRequiredError("assistant-local"));
  assert.equal(mapped instanceof AppError && mapped.code === "CONFIGURATION_ERROR", true);
  assert.match((mapped as Error).message, /qiyan-bot assistant-login/u);
  assert.equal((mapped as AppError).details?.reason, "assistant_auth_required");
  const ordinary = new Error("ordinary");
  assert.equal(assistantAuthenticationStartupError(ordinary), ordinary);
});
