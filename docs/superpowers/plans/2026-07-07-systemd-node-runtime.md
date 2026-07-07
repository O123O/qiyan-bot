# systemd Node Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate QiYan's systemd user service with the exact absolute Node runtime used during service installation.

**Architecture:** Make the Node executable an explicit input to both the systemd unit renderer and controller. The CLI passes `process.execPath`, and the renderer validates and quotes Node before the QiYan script in `ExecStart`.

**Tech Stack:** Strict TypeScript, Node.js built-ins, systemd user units, Node test runner.

---

### Task 1: Add the service-unit regression test

**Files:**
- Modify: `tests/service/systemd-user.test.ts`

- [ ] **Step 1: Write the failing renderer test**

Pass `nodeExecutable: "/home/user/Node Runtime/node%24"` into `renderSystemdUserUnit`, assert that `ExecStart` begins with that safely quoted path followed by the QiYan executable, and add a relative-Node-path rejection assertion.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/service/systemd-user.test.ts`

Expected: FAIL because the renderer ignores `nodeExecutable` and still places the QiYan script first in `ExecStart`.

### Task 2: Pass the exact Node runtime into the generated unit

**Files:**
- Modify: `src/service/systemd-user.ts`
- Modify: `src/main.ts`
- Modify: `tests/service/systemd-user.test.ts`

- [ ] **Step 1: Update the renderer and controller inputs**

Add `nodeExecutable: string` to `renderSystemdUserUnit`, validate it with `systemdPath`, and render:

```typescript
ExecStart=${nodeExecutable} ${executable} --home ${qiyanHome}
```

Add `nodeExecutable: string` to `SystemdUserService` options and pass it through during installation.

- [ ] **Step 2: Supply the production runtime**

Construct the controller in `src/main.ts` with:

```typescript
const service = new SystemdUserService({
  userHome,
  nodeExecutable: process.execPath,
  executable,
  env,
});
```

- [ ] **Step 3: Update deterministic controller fixtures**

Add `nodeExecutable: "/usr/bin/node"` to every `SystemdUserService` construction in `tests/service/systemd-user.test.ts`, and assert installed unit content starts with `/usr/bin/node` before QiYan.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- tests/service/systemd-user.test.ts && npm run typecheck`

Expected: all focused tests pass and TypeScript exits 0.

### Task 3: Verify and commit the branch

**Files:**
- Verify: `src/service/systemd-user.ts`
- Verify: `src/main.ts`
- Verify: `tests/service/systemd-user.test.ts`

- [ ] **Step 1: Run repository verification**

Run: `npm run check`

Expected: TypeScript and the complete test suite exit 0.

- [ ] **Step 2: Review the exact diff and generated command**

Run: `git diff --check && git diff -- src/service/systemd-user.ts src/main.ts tests/service/systemd-user.test.ts`

Expected: no whitespace errors; only the explicit runtime plumbing, assertions, and planning documentation are present.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts src/service/systemd-user.ts tests/service/systemd-user.test.ts docs/superpowers/specs/2026-07-07-systemd-node-runtime-design.md docs/superpowers/plans/2026-07-07-systemd-node-runtime.md
git commit -m "fix: pin Node runtime in systemd service"
```
