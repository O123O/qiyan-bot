export function runBackground(task: () => Promise<void>, onError: (error: unknown) => void): void {
  void Promise.resolve().then(task).catch((error) => {
    try { onError(error); }
    catch { /* background error reporting must never create another rejection */ }
  });
}
