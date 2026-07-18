const CONFIRMATION_TIMEOUT_MS = 30_000;
const MAX_POLL_DELAY_MS = 500;

export async function waitForCompactionEvidence<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  let delayMs = 25;
  while (true) {
    const evidence = await read();
    if (evidence !== undefined) return evidence;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return undefined;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
    delayMs = Math.min(delayMs * 2, MAX_POLL_DELAY_MS);
  }
}
