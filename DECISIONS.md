# Engineering Decisions

I kept the implementation deliberately small because the main goal of the assessment is to make the money-moving flow correct under retries, concurrency, and provider failures.

## Invariants

### Authorization

A user can only initiate a transfer from an account they own.

The backend is responsible for enforcing this. The demo `x-demo-user` header is only a simulated authentication mechanism for the assessment.

### Amounts

All money is represented as integer minor units.

The API does not infer or multiply units.

For example:

`125000` represents ₦1,250.00.

Amounts must be positive integers.

### Idempotency

Every transfer request requires an `Idempotency-Key`.

For the same user:

- the same key with the same request returns the original transfer;
- the same key with a different request returns `409`;
- concurrent requests using the same key cannot create multiple transfers.

The database constraint is important here because an in-memory check is not enough when requests race.

### Balance

An account cannot be debited when it does not have enough funds.

The balance check and balance change are protected by a database transaction so concurrent requests cannot both spend the same funds.

### Provider uncertainty

A provider timeout is not treated as a failed transfer.

If the provider accepted the instruction but the response was lost, the transfer becomes `uncertain`.

The provider reference is preserved even when the provider call throws, so reconciliation can still ask the provider for the final status.

### Webhooks

Provider callbacks must have a valid HMAC-SHA256 signature.

Webhook event IDs are stored so the same event cannot be processed more than once.

Only valid state transitions are accepted.

### Reconciliation

Reconciliation is safe to run more than once.

A transfer that has already reached a terminal state cannot be settled or reversed again.

This also protects against two reconciliation workers processing the same transfer.

---

## Transaction Boundaries

Local database operations that must happen together are kept inside database transactions.

For transfer initiation, the local transfer record and balance reservation/debit are handled transactionally before the external provider call.

The provider call cannot be part of the database transaction because it is an external system.

After the provider responds, the transfer is updated according to the result.

If the provider rejects the transfer, the reserved/debited funds are restored and the transfer becomes `failed`.

If the provider response is lost, the transfer remains recorded as `uncertain` and the provider reference is retained for reconciliation.

Webhook processing uses a transaction when recording the event, validating the transfer state, and applying any related financial change.

Reconciliation gets the provider status outside the database transaction and then performs the final transfer/state update transactionally. This prevents two workers from applying the same financial effect.

---

## Provider Accepted, Response Lost

This is the main failure scenario in the assessment.

The flow is:

1. A transfer is created locally.
2. The account balance is protected/reserved.
3. The provider receives the instruction.
4. The provider accepts it.
5. The response is lost or times out.
6. The transfer is marked `uncertain`.
7. The provider reference is retained.
8. Reconciliation calls `provider.getStatus()` using that reference.
9. A successful provider result moves the transfer to `succeeded`.
10. A failed provider result restores the funds and moves the transfer to `reversed`.

I do not claim distributed exactly-once delivery. The design instead protects the invariants that can be enforced locally: one logical transfer, one effective debit, and one effective reversal.

---

## Operations UI

The frontend is intentionally small and focused on operational visibility.

It allows an operator to:

- see `pending`, `uncertain`, `succeeded`, `failed`, and `reversed` transfers;
- filter transfers by status;
- identify transfers that need reconciliation;
- trigger reconciliation;
- see loading states;
- see API and operation errors;
- avoid submitting another transfer while a request is already in progress.

The frontend does not provide financial correctness. Authorization, idempotency, balance protection, webhook verification, and reconciliation safety remain backend responsibilities.

---

## Replacing SQLite at Scale

SQLite is appropriate for this assessment because it keeps the project simple and requires no external service.

For a production deployment, I would move the database to PostgreSQL.

The existing transaction boundaries and database constraints would remain important.

PostgreSQL would provide better support for:

- multiple application instances;
- concurrent transactions;
- row-level locking;
- connection pooling;
- backups and recovery;
- production database monitoring.

I would keep correctness in the database rather than relying on application-memory locks.

---

## Replacing the In-Process Worker

The current reconciliation mechanism is intentionally simple.

At scale, I would move reconciliation to a durable queue and worker system.

Workers should assume at-least-once delivery, which means the reconciliation operation must remain idempotent.

The database would still be the final authority for deciding whether a transfer can move from an unresolved state to a terminal state.

This means a duplicated job would not cause a second debit or reversal.

---

## Logging

I would use structured logs containing:

- transfer ID;
- provider reference;
- provider event ID;
- user ID;
- account ID;
- previous status;
- new status;
- operation;
- error type;
- correlation/request ID;
- request duration.

I would not log provider credentials, BVNs, secrets, or other sensitive data.

---

## Metrics

I would track:

- transfers created;
- successful transfers;
- failed transfers;
- reversed transfers;
- uncertain transfers;
- provider timeouts;
- provider errors;
- idempotency conflicts;
- invalid webhook attempts;
- duplicate webhook events;
- reconciliation failures;
- number and age of unresolved transfers.

The number and age of `uncertain` transfers would be especially important because they represent money whose final provider state has not yet been confirmed.

---

## Alerting

I would alert on:

- a growing number of uncertain transfers;
- old unresolved transfers;
- increased provider timeouts;
- increased provider failures;
- webhook signature failures;
- reconciliation failures;
- unusual reversal rates;
- database failures.

---

## Audit Data

For a real money-moving system, I would keep a durable audit trail for important financial events.

Examples include:

- transfer created;
- balance reserved/debited;
- provider request sent;
- provider response received;
- provider timeout;
- webhook received;
- webhook rejected;
- transfer status changed;
- reconciliation performed;
- reversal applied.

Each event should contain the transfer ID, timestamp, source, previous state, new state, and reason.

The audit trail should be separate from normal application logs.

---

## Known Limitations

This is intentionally a small assessment implementation.

Known limitations include:

- authentication is simulated with `x-demo-user`;
- SQLite is not intended for a multi-instance production deployment;
- the provider is a deterministic fake provider;
- reconciliation is exposed through an admin HTTP endpoint;
- there is no production RBAC system;
- there is no production secret-management solution;
- observability is basic;
- there is no distributed exactly-once guarantee;
- the operations UI is intentionally limited to the requirements of the assessment.

These are trade-offs made to keep the implementation focused on correctness within the assessment timebox.

---

## Next Three Changes

### 1. Move to PostgreSQL and durable workers

Replace SQLite with PostgreSQL and move reconciliation into a durable queue/worker system.

### 2. Add real authentication and authorization

Replace the demo header with real authentication, roles, permissions, and proper secret management.

### 3. Improve observability and auditing

Add structured logging, metrics, tracing, dashboards, alerts, and a durable audit trail for money-moving state changes.

---

## AI Assistance

AI tools were used to help review the starter implementation, identify concurrency and idempotency risks, reason through provider failure scenarios, and review focused test cases.

They were also used to help structure parts of the documentation.

I reviewed the resulting implementation against the assessment requirements and remain responsible for the submitted code and design decisions.
