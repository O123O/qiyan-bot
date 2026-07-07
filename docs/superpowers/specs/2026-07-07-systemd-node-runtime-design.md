# systemd Node Runtime Design

## Problem

The generated user service launches the installed `qiyan-bot` JavaScript file directly. Its shebang is `#!/usr/bin/env node`, so startup depends on the systemd user manager's PATH. A user-local Node installation can run QiYan from an interactive shell while remaining invisible to systemd, causing the service to exit with status 127 before any chat adapter starts.

## Design

During `qiyan-bot service install`, the running process supplies `process.execPath` as the Node executable. `SystemdUserService` carries this explicit dependency to `renderSystemdUserUnit`, which validates and quotes it with the same rules already used for the QiYan executable and home path.

The generated command has this shape:

```ini
ExecStart="/absolute/path/to/node" "/absolute/path/to/qiyan-bot" --home "/absolute/path/to/qiyan-home"
```

This removes runtime PATH lookup while keeping the unit secret-free. It deliberately does not copy the caller's PATH into the service environment.

## Error Handling and Compatibility

Relative Node paths and paths containing unsupported systemd characters are rejected as configuration errors through the existing path validator. Existing managed units retain the current replacement safety rule: when the generated content changes, the operator uninstalls and reinstalls the managed service. A later Node relocation likewise requires service reinstallation so a fresh runtime path can be captured.

## Testing

The service-unit test will first assert the new two-executable `ExecStart` form and fail against current behavior. It will also cover validation of the Node path. Controller tests will inject a deterministic Node path and verify that installed unit content contains it. Finally, focused service tests, TypeScript checking, and the full `npm run check` suite will run.
