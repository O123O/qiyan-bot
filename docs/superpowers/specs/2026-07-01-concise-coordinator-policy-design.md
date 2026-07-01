# Concise Coordinator Policy Design

## Goal

Reduce durable coordinator prompt weight without removing behavior that is specific to codex-bot. Ordinary MCP tools already expose descriptions and argument schemas, so the managed policy should not duplicate their usage with worked examples.

## Policy structure

Keep the coordinator-specific operating contract: project routing, receipt-backed state, automatic worker-result delivery, supervision, the read-only session dashboard and registry, model/goal semantics, attachment safety, and real failure states. Condense repeated tool-by-tool instructions where the MCP description is sufficient.

Keep a categorized tool catalog listing every exposed coordinator tool. The catalog tells the coordinator what capabilities exist while leaving ordinary argument details to MCP discovery.

## Exact directives

`/pass` and `/collect` remain detailed because their semantics cannot be inferred from the ordinary tool schemas alone. Preserve:

- the exact payload and attachment-order rules for `/pass`;
- the distinction between `start` and `steer`;
- the exact count and direct-delivery behavior for `/collect`;
- one worked example for each directive, including the leading-space `/pass` edge case; and
- the rule not to repeat or summarize directly collected bodies.

## Removed material

Remove worked examples for creating, discovering, adopting, reading status, and updating manager notes. Remove the general `Worked examples` section in favor of an `Exact directive examples` section containing only `/pass` and `/collect`.

## Verification

Update the policy test so it requires the two exact-directive examples, the categorized presence of every MCP tool, and all coordinator-specific safety/state rules. It must reject the removed ordinary examples and no longer enforce a minimum byte length, since brevity is now an explicit requirement.
