# Slack adapter

Status: Planned

Slack support is not implemented in this release. The backend already separates normalized chat messages, attachments, delivery, and coordinator routing from Telegram-specific transport, so a future Slack adapter can use the same contracts without changing Codex session identity.

There is currently no supported Slack app manifest, event subscription, credential configuration, or installation procedure. Do not expose a Slack workspace to this binary expecting it to work. Track the repository's future releases for an implemented adapter and a security-reviewed setup guide.
