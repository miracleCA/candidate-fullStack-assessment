# Risk Notes

I focused on risks that can cause incorrect money movement, unauthorized transfers, or an incorrect transfer state. I did not try to fix unrelated style issues.

## 1. Concurrent duplicate transfers — Critical

The original implementation checked for an existing idempotency key and then called the provider. Two requests arriving at the same time could both pass the check and create two provider instructions.

This could result in the same transfer being sent twice and the account being debited more than once.

### Invariant

The same user, idempotency key, and request must result in one logical transfer, one provider instruction, and one effective debit.

### Mitigation

Idempotency is enforced at the database level, and transfer creation is protected against concurrent requests rather than relying only on an application-level check.

---

## 2. Provider accepts the transfer but the response is lost — Critical

The provider can accept a transfer and then time out before the application receives the response.

Treating this as an ordinary failure could cause the client to retry and create another provider instruction.

### Invariant

A missing provider response must never be treated as proof that the transfer failed.

### Mitigation

The transfer is kept locally and moved to `uncertain`. The provider reference is preserved even when the response is lost so that reconciliation can query the provider later.

---

## 3. Balance race condition — Critical

Two requests can try to spend the same account balance at the same time.

Without an atomic balance check and update, both requests could see enough funds and spend money that is no longer available.

### Invariant

An account must never be debited below its available balance.

### Mitigation

The balance reservation/debit is performed inside a database transaction.

---

## 4. Missing account ownership check — Critical

The original implementation looked up an account using only its ID. It did not verify that the authenticated user owned the account.

This could allow one demo user to initiate a transfer from another user's account.

### Invariant

Only the owner of the debit account can initiate a transfer from it.

### Mitigation

The account owner is checked against the authenticated user before the transfer can be created.

---

## 5. Missing idempotency key — High

The original API allowed transfers without an `Idempotency-Key`.

Clients commonly retry requests, so there needs to be a way to identify that a retry represents the same operation.

### Invariant

Every transfer initiation must have an idempotency key.

### Mitigation

The API requires the `Idempotency-Key` header and detects reuse of the same key with a different request.

---

## 6. Forged provider webhooks — Critical

The original webhook endpoint accepted callbacks without verifying the provider signature.

An attacker could potentially submit a fake callback and change the state of a transfer.

### Invariant

Only authenticated provider events can change transfer state.

### Mitigation

The webhook verifies `x-provider-signature` using HMAC-SHA256, the configured webhook secret, and the exact JSON request body.

---

## 7. Duplicate webhook events — High

Payment providers can retry webhook events.

Without deduplication, the same event could be processed more than once and cause a financial side effect more than once.

### Invariant

Processing the same provider event multiple times must have the same effect as processing it once.

### Mitigation

Provider event IDs are stored with a unique constraint and duplicate events are ignored.

---

## 8. Invalid transfer state changes — High

The original webhook handler directly assigned whatever status was supplied by the request.

This could move a transfer backwards, for example from `succeeded` to `failed`.

### Invariant

A transfer can only move through valid state transitions.

### Mitigation

Webhook and reconciliation updates check the current transfer state before applying a new state.

---

## 9. Concurrent reconciliation — Critical

Two reconciliation workers could read the same unresolved transfer and both process it.

For a failed provider transfer, this could result in the account being refunded twice.

### Invariant

A transfer can only be settled or reversed once.

### Mitigation

The transfer state and financial adjustment are updated atomically. A worker must successfully claim the unresolved state before applying the financial effect.

---

## 10. Sensitive account information exposed — High

The original `/api/accounts` endpoint returned the entire account row.

That included provider credentials and identity information that the frontend does not need.

### Invariant

Sensitive provider and identity data must not be returned through normal account APIs.

### Mitigation

The account endpoint only returns the fields required by the operations screen.

---

## Priority Summary

The highest risks are the ones that can directly cause incorrect money movement:

1. Concurrent duplicate transfers
2. Provider accepted but response was lost
3. Balance race conditions
4. Unauthorized account debits
5. Concurrent reconciliation

Webhook authentication, webhook deduplication, and idempotency are also critical because they protect the state and financial effects of a transfer.
