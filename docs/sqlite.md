# SQLite durability and recovery

## Durability

File-backed QiYan databases use a rollback journal with `journal_mode=DELETE`, `synchronous=EXTRA`, foreign keys, and a bounded busy timeout. They do not use WAL. QiYan also holds an adjacent lifetime lock, so only one QiYan process may own a data directory at a time. For every recognized QiYan database that is nonempty, startup runs a full `PRAGMA integrity_check` before chat adapters, Codex endpoints, or reconciliation can start; a corrupt authoritative store fails closed instead of accepting more work.

These settings avoid SQLite WAL's shared-memory limitation on network filesystems, but they do not make every NFS deployment inherently safe. NFS lock and sync semantics remain correctness dependencies: the mount and server must provide what SQLite requires. Keep reliable backups and do not bypass the one-process lease.

## Backups

For a filesystem backup, stop QiYan and confirm the service is inactive. Copy `bot.sqlite3` and every existing `bot.sqlite3-wal`, `bot.sqlite3-shm`, and `bot.sqlite3-journal` together with the rest of the data directory; never mix files from different snapshots. A live backup must instead use the SQLite online backup API. The assistant profile contains credentials, so protect the whole backup as private state.

## Automatic dashboard-metadata recovery

QiYan does not need periodic shutdowns or database maintenance. At startup, while holding the one-process lease, QiYan automatically retains a private backup, rebuilds only damaged derived dashboard metadata, verifies the replacement, and completes recovery before chat adapters start.

Recovery proceeds only when every authoritative row is readable and the current QiYan schema is exact. If authoritative data is unreadable, files change during inspection, or the schema is unexpected, startup stops safely instead of guessing. Backups that reached their durable manifest boundary remain private and retained for support.
