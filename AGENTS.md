# Repository guidance

- Use strict TypeScript and Node.js built-ins where practical.
- Add or update a failing test before changing behavior.
- Run `npm run check` before committing.
- Never log Telegram message bodies, attachment contents, bot tokens, or Codex credentials.
- Keep chat adapters, app-server transport, session policy, and persistence behind separate interfaces.
