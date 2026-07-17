import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "qiyan-webui-check-"));
const output = join(temporary, "webui");

try {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn("npm", ["--prefix", "webui-client", "run", "build", "--", "--outDir", output], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`Web UI build exited with status ${String(code)}`)));
  });
  const [committed, built] = await Promise.all([
    readFile(join(root, "assets", "webui", "index.html")),
    readFile(join(output, "index.html")),
  ]);
  if (!committed.equals(built)) {
    throw new Error("Web UI asset is stale; run `npm --prefix webui-client run build`");
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
