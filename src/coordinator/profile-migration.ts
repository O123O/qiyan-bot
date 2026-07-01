import { realpath } from "node:fs/promises";
import type { CoordinatorRuntime } from "./runtime.ts";
import { AppError } from "../core/errors.ts";

export interface LegacyCoordinatorTurn {
  id: string;
  status: string;
  completedAt?: number | null;
  error?: unknown;
  items: Array<{ type: string; id?: string; clientId?: string; phase?: string | null; text?: string }>;
}

export async function recoverCoordinatorProfileAttempts(input: {
  runtime: CoordinatorRuntime;
  legacyThreadId: string;
  coordinatorDir: string;
  readLegacyThread(): Promise<{ id: string; cwd: string; turns: LegacyCoordinatorTurn[] }>;
  reconcileOperations(): Promise<void>;
  completeTurn(turn: LegacyCoordinatorTurn): Promise<void>;
}): Promise<void> {
  await input.reconcileOperations();
  const active = input.runtime.activeAttempts();
  if (active.length === 0) return;
  let turns: LegacyCoordinatorTurn[] = [];
  if (input.legacyThreadId !== "pending") {
    const thread = await input.readLegacyThread();
    if (thread.id !== input.legacyThreadId) throw new AppError("CONFIGURATION_ERROR", "legacy coordinator history returned a different thread identity");
    if (!await sameDirectory(thread.cwd, input.coordinatorDir)) throw new AppError("CONFIGURATION_ERROR", "legacy coordinator history returned a different working directory");
    turns = thread.turns;
  }

  for (const original of active) {
    let turnId = original.turnId;
    let turn = turnId.startsWith("pending:")
      ? [...turns].reverse().find((candidate) => candidate.items.some((item) => item.type === "userMessage" && item.clientId === original.contextId))
      : turns.find((candidate) => candidate.id === turnId);
    if (turn && turnId.startsWith("pending:")) {
      input.runtime.bindTurn(original.attemptId, turn.id);
      turnId = turn.id;
    }
    if (turn?.status === "completed") await input.completeTurn(turn);
    else if (turn && isTerminal(turn.status)) input.runtime.failAttempt(turnId, turn.error ?? `legacy coordinator turn ${turn.status}`);
  }

  for (const unresolved of input.runtime.activeAttempts()) {
    input.runtime.failAttempt(unresolved.turnId, new Error("coordinator profile migration replaced the previous app-server thread"));
  }
}

function isTerminal(status: string): boolean {
  return status === "failed" || status === "interrupted";
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  try { return await realpath(left) === await realpath(right); }
  catch { return false; }
}
