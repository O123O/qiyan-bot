import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

const fixturePath = (name: string): string => `docker/ssh-worker/${name}`;
const readFixture = (name: string): Promise<string> => readFile(fixturePath(name), "utf8");

test("SSH worker image pins its base, packages, account, and copied inputs", async () => {
  const dockerfile = await readFixture("Dockerfile");

  assert.match(dockerfile, /^FROM node:24-bookworm-slim\n/u);
  assert.match(dockerfile, /^ARG CODEX_VERSION=0\.142\.5$/mu);
  assert.match(dockerfile, /^ENV CODEX_HOME=\/home\/codex\/\.codex$/mu);
  assert.match(
    dockerfile,
    /^RUN apt-get update \\\n && apt-get install -y --no-install-recommends \\\n\s+ca-certificates \\\n\s+git \\\n\s+openssh-client \\\n\s+openssh-server \\\n\s+procps \\\n\s+tmux \\\n && rm -f \/etc\/ssh\/ssh_host_\* \\\n && npm install --global "@openai\/codex@\$\{CODEX_VERSION\}" \\/mu,
  );
  assert.match(
    dockerfile,
    /useradd --create-home --home-dir \/home\/codex --shell \/bin\/bash --password NP codex/u,
  );
  assert.match(dockerfile, /install -d -m 0700 -o codex -g codex \/home\/codex\/\.ssh \/home\/codex\/\.codex/u);
  assert.match(dockerfile, /install -d -m 0700 -o codex -g codex \/home\/codex\/projects/u);
  assert.match(dockerfile, /install -d -m 0700 -o root -g root \/var\/lib\/ssh-host-keys/u);
  assert.doesNotMatch(dockerfile, /passwd\s+-d/u);
  assert.doesNotMatch(dockerfile, /\b(?:USER|user)\s+root\b/u);

  const copies = dockerfile.match(/^COPY .+$/gmu) ?? [];
  assert.equal(copies.length, 2);
  assert.equal(copies[0], "COPY sshd_config /etc/ssh/sshd_config");
  assert.equal(
    copies[1],
    "COPY entrypoint.sh /usr/local/bin/ssh-worker-entrypoint",
  );
  assert.doesNotMatch(dockerfile, /COPY --chmod/u);
  assert.match(dockerfile, /^RUN chmod 0755 \/usr\/local\/bin\/ssh-worker-entrypoint$/mu);
  assert.doesNotMatch(copies.join("\n"), /auth\.json|\.codex|QIYAN_HOME/u);
  assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/local\/bin\/ssh-worker-entrypoint"\]$/mu);
});

test("SSH worker Compose service is isolated and localhost-only", async () => {
  const compose = await readFixture("compose.yaml");
  const services = compose.slice(compose.indexOf("services:"), compose.indexOf("\nvolumes:"));

  assert.equal((services.match(/^  [a-z0-9-]+:\s*$/gmu) ?? []).join("\n"), "  ssh-worker:");
  assert.doesNotMatch(compose, /^name:/mu);
  assert.match(compose, /^\s{6}context: \.$/mu);
  assert.match(compose, /^\s{6}dockerfile: Dockerfile$/mu);
  assert.match(compose, /^\s{8}CODEX_VERSION: \$\{QIYAN_SSH_WORKER_CODEX_VERSION:-0\.142\.5\}$/mu);
  assert.match(
    compose,
    /^\s{4}ports:\n\s{6}- "127\.0\.0\.1:\$\{QIYAN_SSH_WORKER_PORT:-2222\}:22"\n\s{4}volumes:$/mu,
  );
  assert.doesNotMatch(compose, /network_mode:\s*host/u);

  assert.match(compose, /source: \$\{QIYAN_SSH_WORKER_PUBLIC_KEY:\?[^}\n]+\}/u);
  assert.match(compose, /target: \/run\/qiyan\/authorized_key\.pub\n\s+read_only: true/u);
  assert.match(compose, /source: codex-profile\n\s+target: \/home\/codex\/\.codex/u);
  assert.match(compose, /source: projects\n\s+target: \/home\/codex\/projects/u);
  assert.match(compose, /source: ssh-host-keys\n\s+target: \/var\/lib\/ssh-host-keys/u);
  assert.equal(
    compose.slice(compose.indexOf("\nvolumes:") + 1),
    "volumes:\n  codex-profile:\n  projects:\n  ssh-host-keys:\n",
  );

  assert.doesNotMatch(compose, /^\s+(?:environment|env_file):/mu);
  assert.doesNotMatch(compose, /auth\.json|\$\{?HOME\}?|~\/\.codex/u);
  assert.match(compose, /ssh-keyscan -T [1-9][0-9]* -t ed25519 -p 22 127\.0\.0\.1/u);
  assert.match(compose, /grep -q [^\n]*ssh-ed25519/u);
  assert.match(compose, /^\s{6}timeout: [1-9][0-9]*s$/mu);
  assert.match(compose, /^\s{6}retries: [1-9][0-9]*$/mu);
});

test("SSH daemon accepts only the codex user's public key", async () => {
  const config = await readFixture("sshd_config");

  for (const directive of [
    "HostKey /var/lib/ssh-host-keys/ssh_host_ed25519_key",
    "AuthorizedKeysFile .ssh/authorized_keys",
    "PubkeyAuthentication yes",
    "AuthenticationMethods publickey",
    "PermitRootLogin no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PermitEmptyPasswords no",
    "AllowUsers codex",
    "DisableForwarding no",
    "AllowTcpForwarding no",
    "AllowStreamLocalForwarding local",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitTunnel no",
    "SetEnv CODEX_HOME=/home/codex/.codex",
    "UsePAM no",
  ]) {
    assert.match(config, new RegExp(`^${directive.replaceAll("/", "\\/")}$`, "mu"), `missing ${directive}`);
  }
});

test("effective SSH policy enables only local stream-local forwarding", async (t) => {
  const sshd = "/usr/sbin/sshd";
  const sshKeygen = "/usr/bin/ssh-keygen";
  try { await Promise.all([access(sshd), access(sshKeygen)]); }
  catch { t.skip("host sshd is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "qiyan-sshd-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostKey = join(root, "host-key");
  await execFileAsync(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  const path = join(root, "sshd_config");
  const source = (await readFixture("sshd_config"))
    .replace("HostKey /var/lib/ssh-host-keys/ssh_host_ed25519_key", `HostKey ${hostKey}`);
  await writeFile(path, source);

  const { stdout } = await execFileAsync(sshd, ["-T", "-f", path, "-C", "user=codex,host=localhost,addr=127.0.0.1"]);

  // OpenSSH 10.4 may preserve keyword casing in `sshd -T` output. Keywords are
  // case-insensitive, so validate the effective values without pinning casing.
  assert.match(stdout, /^allowstreamlocalforwarding local$/imu);
  assert.match(stdout, /^allowtcpforwarding no$/imu);
  assert.match(stdout, /^allowagentforwarding no$/imu);
  assert.match(stdout, /^x11forwarding no$/imu);
  assert.match(stdout, /^permittunnel no$/imu);
});

test("SSH worker entrypoint provisions only fixture-owned SSH state", async () => {
  const entrypoint = await readFixture("entrypoint.sh");

  assert.match(entrypoint, /^#!\/bin\/sh\nset -eu\numask 077\n/u);
  assert.match(entrypoint, /install -d -m 0755 \/run\/sshd/u);
  assert.match(entrypoint, /ssh-keygen -l -f "\$authorized_key_source" >\/dev\/null/u);
  assert.match(entrypoint, /host_key=\/var\/lib\/ssh-host-keys\/ssh_host_ed25519_key/u);
  assert.match(entrypoint, /if \[ ! -f "\$host_key" \]; then\n\s+ssh-keygen -q -t ed25519 -N '' -f "\$host_key"\nfi/u);
  assert.deepEqual(entrypoint.match(/^[ \t]*ssh-keygen .+$/gmu), [
    'ssh-keygen -l -f "$authorized_key_source" >/dev/null',
    '  ssh-keygen -q -t ed25519 -N \'\' -f "$host_key"',
  ]);
  assert.match(
    entrypoint,
    /install -m 0600 -o codex -g codex "\$authorized_key_source" \/home\/codex\/\.ssh\/authorized_keys/u,
  );
  assert.match(entrypoint, /install -d -m 0700 -o codex -g codex \/home\/codex\/\.codex \/home\/codex\/projects/u);
  assert.match(entrypoint, /install -d -m 0700 -o root -g root \/var\/lib\/ssh-host-keys/u);
  assert.match(entrypoint, /\/usr\/sbin\/sshd -t -f \/etc\/ssh\/sshd_config/u);
  assert.match(entrypoint, /exec \/usr\/sbin\/sshd -D -e -f \/etc\/ssh\/sshd_config\n$/u);
});

test("Docker context root has a conventional deny-all allowlist", async () => {
  await assert.rejects(
    readFixture("Dockerfile.dockerignore"),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  assert.equal(
    await readFixture(".dockerignore"),
    "**\n!entrypoint.sh\n!sshd_config\n",
  );
});

test("release package allowlist excludes development fixture and generated SSH state", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as { files?: unknown };
  assert.ok(Array.isArray(manifest.files));
  const files = manifest.files as unknown[];
  assert.equal(files.every((value) => typeof value === "string"), true);
  assert.equal(files.some((value) => (value as string).startsWith("scripts")), false);
  assert.equal(files.some((value) => (value as string).startsWith("docker")), false);
  assert.equal(files.some((value) => (value as string).includes(".tmp")), false);
});
