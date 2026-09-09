---
name: "finance"
description: "Use the purpose-specific finance tools to record transactions, inspect summaries, and manage subscription snapshots. Database setup and migration are automatic."
---

# finance

Use the dedicated finance tools instead of SQL or shell commands. The tools operate on the current group’s private finance database; do not ask for or provide a database path, mount, SQL query, or setup command.

## Transactions

- `finance-record-transaction`: record one transaction with `type` set to `income` or `expense` and a positive integer `amount` in yen. The tool applies the stored sign.
- `finance-list-transactions`: inspect transaction history, optionally filtering by `from`, `to`, `category`, or `type`.
- `finance-summary`: get income, expense, net, and category totals for a period. It defaults to the current month.

## Subscriptions

- `finance-add-subscription`: add a subscription using its name, positive cost, cycle, and next renewal date.
- `finance-update-subscription`: append a changed snapshot for an existing subscription.
- `finance-cancel-subscription`: append an inactive snapshot; it never deletes history.
- `finance-list-subscriptions`: list each subscription’s latest snapshot (active subscriptions by default).
- `finance-subscription-history`: inspect every snapshot for one subscription name.

Subscription identity is the `name` value. Updates and cancellations are append-only, so older snapshots remain available in the history tool. Do not use a generic query tool or direct SQL. Database initialization and compatibility migration happen inside the trusted finance Runtime automatically.
