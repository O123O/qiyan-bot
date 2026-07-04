import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WEIXIN_PROTOCOL_REFERENCE } from "../../src/weixin/provenance.ts";

test("pins only the reviewed Tencent protocol dependencies", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    devDependencies: Record<string, string>;
  };

  assert.equal(manifest.devDependencies["lossless-json"], "4.3.0");
  assert.equal(manifest.devDependencies["qrcode-terminal"], "0.12.0");
  assert.equal(WEIXIN_PROTOCOL_REFERENCE.repository, "https://github.com/Tencent/openclaw-weixin");
  assert.equal(WEIXIN_PROTOCOL_REFERENCE.revision, "cef0bfc390393f716903e16d50408118047f87e0");
  assert.equal(WEIXIN_PROTOCOL_REFERENCE.release, "2.4.6");
  assert.equal(WEIXIN_PROTOCOL_REFERENCE.license, "MIT");
  assert.equal(Object.keys(manifest.devDependencies).some((name) => name.toLowerCase().includes("openclaw")), false);
});
