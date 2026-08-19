import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AppDatabase } from "./db.js";
import { systemClock, type Clock, type TransferProvider } from "./types.js";
import { createRequestHash } from "../utils/hash.js";



const transferInput = z.object({
  debitAccountId: z.string().min(1),
  destinationAccount: z.string().regex(/^\d{10}$/),
  amount: z.number().int().positive(),
});

interface AppOptions {
  db: AppDatabase;
  provider: TransferProvider;
  webhookSecret?: string;
  clock?: Clock;
}

interface DemoRequest extends Request {
  demoUser?: string;
  rawBody?: Buffer;
}

type TransferRow = Record<string, unknown>;

function authenticate(req: DemoRequest, res: Response, next: NextFunction): void {
  const user = req.header("x-demo-user");

  if (!user) {
    res.status(401).json({ error: "x-demo-user is required" });
    return;
  }

  req.demoUser = user;
  next();
}

function requireOpsAdmin(req: DemoRequest, res: Response, next: NextFunction): void {
  if (req.demoUser !== "ops-admin") {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  next();
}

function publicTransfer(row: TransferRow) {
  return {
    id: row.id,
    debitAccountId: row.debit_account_id,
    destinationAccount: row.destination_account,
    amount: row.amount,
    status: row.status,
    providerReference: row.provider_reference,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isValidTransition(current: string, next: string): boolean {
  const transitions: Record<string, string[]> = {
    pending: ["succeeded", "failed", "uncertain"],
    uncertain: ["succeeded", "reversed"],
    succeeded: [],
    failed: [],
    reversed: [],
  };

  return transitions[current]?.includes(next) ?? false;
}

function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const provided = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (provided.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(provided, expectedBuffer);
}

function requestHash(input: { debitAccountId: string; destinationAccount: string; amount: number }): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        debitAccountId: input.debitAccountId,
        destinationAccount: input.destinationAccount,
        amount: input.amount,
      }),
    )
    .digest("hex");
}

export function createApp({ db, provider, webhookSecret = "local-webhook-secret", clock = systemClock }: AppOptions) {
  const app = express();

  app.use(express.json({
    verify: (req, _res, buffer) => {
      (req as DemoRequest).rawBody = Buffer.from(buffer);
    },
  }));

  app.get("/api/health", (_req, res) => { res.json({ ok: true }) });

  app.get("/api/accounts", authenticate, (req: DemoRequest, res) => {
    const rows = db.prepare(`
      SELECT id, owner_id, name, balance
      FROM accounts
      WHERE owner_id = ?
      ORDER BY id
    `).all(req.demoUser!);

    res.json(rows);
  });

  app.get("/api/transfers", authenticate, (req: DemoRequest, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    const rows = status
      ?
      db.prepare(`
        SELECT *
        FROM transfers
        WHERE owner_id = ?
          AND status = ?
        ORDER BY created_at DESC
      `).all(req.demoUser!, status)
      :
      db.prepare(`
        SELECT *
        FROM transfers
        WHERE owner_id = ?
        ORDER BY created_at DESC
      `).all(req.demoUser!);

    res.json(rows.map((row) => publicTransfer(row as TransferRow)));
  });

  app.post("/api/transfers", authenticate, async (req: DemoRequest, res: Response) => {
    const parsed = transferInput.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "invalid transfer", details: parsed.error.issues });
      return;
    }

    const input = parsed.data;
    const idempotencyKey = req.header("idempotency-key");
    const requestHash = createRequestHash(input);

    if (!idempotencyKey) {
      res.status(400).json({ error: "Idempotency-Key header is required" });
      return;
    }

    const ownerId = req.demoUser!;

    const existing = db.prepare(`
      SELECT *
      FROM transfers
      WHERE owner_id = ?
        AND idempotency_key = ?
    `).get(ownerId, idempotencyKey) as | TransferRow | undefined;

    if (existing) {
      if (existing.request_hash !== requestHash) {
        res.status(409).json({ error: "idempotency key already used with a different request" });
        return;
      }

      res.json(publicTransfer(existing));
      return;
    }

    const transferId = crypto.randomUUID();
    const now = clock.now().toISOString();

    try {
      db.exec("BEGIN IMMEDIATE");

      const account = db.prepare(`
        SELECT id, owner_id, balance
        FROM accounts
        WHERE id = ?
      `).get(input.debitAccountId) as | { id: string; owner_id: string; balance: number; } | undefined;

      if (!account) {
        db.exec("ROLLBACK");

        res.status(404).json({ error: "account not found" });
        return;
      }

      if (account.owner_id !== ownerId) {
        db.exec("ROLLBACK");

        res.status(403).json({ error: "you do not own this account" });
        return;
      }

      const debit = db.prepare(`
        UPDATE accounts
        SET balance = balance - ?
        WHERE id = ?
          AND owner_id = ?
          AND balance >= ?
      `).run(input.amount, input.debitAccountId, ownerId, input.amount);

      if (Number(debit.changes) !== 1) {
        db.exec("ROLLBACK");

        res.status(422).json({ error: "insufficient funds" });
        return;
      }

      db.prepare(`
        INSERT INTO transfers (
          id,
          owner_id,
          debit_account_id,
          destination_account,
          amount,
          status,
          idempotency_key,
          request_hash,
          provider_reference,
          failure_reason,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(transferId, ownerId, input.debitAccountId, input.destinationAccount, input.amount, "pending", idempotencyKey, requestHash, null, null, now, now);

      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction may already have been rolled back.
      }

      const concurrent = db.prepare(`
        SELECT *
        FROM transfers
        WHERE owner_id = ?
          AND idempotency_key = ?
      `).get(ownerId, idempotencyKey) as | TransferRow | undefined;

      if (concurrent) {
        if (concurrent.request_hash !== requestHash) {
          res.status(409).json({ error: "idempotency key was already used for a different request" });
          return;
        }

        res.json(publicTransfer(concurrent));
        return;
      }

      console.error("failed to create transfer", error);

      res.status(500).json({ error: "could not create transfer" });
      return;
    }

    try {
      const providerResult = await provider.send({ clientReference: transferId, destinationAccount: input.destinationAccount, amount: input.amount });

      const current = db.prepare(`
        SELECT *
        FROM transfers
        WHERE id = ?
      `).get(transferId) as TransferRow;

      const providerStatus = providerResult.status === "accepted" ? "succeeded" : "failed";

      if (!isValidTransition(String(current.status), providerStatus)) {
        res.status(500).json({ error: "invalid transfer state transition" });
        return;
      }

      const updatedAt = clock.now().toISOString();

      db.exec("BEGIN IMMEDIATE");

      if (providerStatus === "failed") {
        db.prepare(`
          UPDATE accounts
          SET balance = balance + ?
          WHERE id = ?
        `).run(input.amount, input.debitAccountId);
      }

      db.prepare(`
        UPDATE transfers
        SET status = ?,
          provider_reference = ?,
          failure_reason = ?,
          updated_at = ?
        WHERE id = ?
          AND status = 'pending'
      `).run(providerStatus, providerResult.providerReference, providerStatus === "failed" ? "provider rejected" : null, updatedAt, transferId);

      db.exec("COMMIT");

      const row = db.prepare(` SELECT * FROM transfers WHERE id = ? `).get(transferId) as TransferRow;

      res.status(201).json(publicTransfer(row));
    } catch (error) {
      const providerReference = error instanceof Error && "providerReference" in error && typeof error.providerReference === "string" ? error.providerReference : null;
      const updatedAt = clock.now().toISOString();

      db.prepare(`
        UPDATE transfers
        SET status = 'uncertain',
            provider_reference = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'pending'
      `).run(providerReference, updatedAt, transferId);

      const row = db.prepare(` SELECT * FROM transfers WHERE id = ? `).get(transferId) as TransferRow;

      console.error("provider response was uncertain", error);
      res.status(202).json(publicTransfer(row));
    }
  });

  app.post("/api/provider/webhook", (req: DemoRequest, res) => {
    const signature = req.header("x-provider-signature");

    if (!verifyWebhookSignature(req.rawBody ?? Buffer.from(""), signature, webhookSecret)) {
      res.status(401).json({ error: "invalid provider signature" });
      return;
    }

    const body = req.body as {
      eventId?: string;
      transferId?: string;
      status?: string;
      providerReference?: string;
    };

    if (!body.eventId || !body.transferId || !body.status) {
      res.status(400).json({ error: "invalid event" });
      return;
    }

    const allowedStatuses = new Set(["succeeded", "failed"]);

    if (!allowedStatuses.has(body.status)) {
      res.status(400).json({ error: "invalid event status" });
      return;
    }

    try {
      db.exec("BEGIN IMMEDIATE");

      const event = db.prepare(`
        SELECT event_id
        FROM webhook_events
        WHERE event_id = ?
      `).get(body.eventId);

      if (event) {
        db.exec("COMMIT");

        res.json({ received: true, duplicate: true });
        return;
      }

      const transfer = db.prepare(`
        SELECT *
        FROM transfers
        WHERE id = ?
      `).get(body.transferId) as | TransferRow | undefined;

      if (!transfer) {
        db.exec("ROLLBACK");

        res.status(404).json({ error: "transfer not found" });
        return;
      }

      if (!isValidTransition(String(transfer.status), body.status)) {
        db.exec("ROLLBACK");

        res.status(409).json({ error: "invalid transfer state transition" });
        return;
      }

      const now = clock.now().toISOString();

      db.prepare(`
        INSERT INTO webhook_events (
          event_id,
          received_at
        )
        VALUES (?, ?)
      `).run(body.eventId, now);

      if (body.status === "failed") {
        db.prepare(`
          UPDATE accounts
          SET balance = balance + ?
          WHERE id = ?
        `).run(Number(transfer.amount), String(transfer.debit_account_id));
      }

      db.prepare(`
        UPDATE transfers
        SET status = ?,
            provider_reference = COALESCE(?, provider_reference),
            failure_reason = ?,
            updated_at = ?
        WHERE id = ?
      `).run(body.status, body.providerReference ?? null, body.status === "failed" ? "provider reported failure" : null, now, body.transferId);

      db.exec("COMMIT");

      res.json({ received: true });
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors.
      }

      console.error("webhook processing failed", error);
      res.status(500).json({ error: "could not process webhook" });
    }
  });

  app.post("/api/admin/reconcile", authenticate, requireOpsAdmin, async (_req: DemoRequest, res: Response) => {
    const transfers = db.prepare(`
      SELECT *
      FROM transfers
      WHERE status IN ('pending', 'uncertain')
        AND provider_reference IS NOT NULL
      ORDER BY created_at ASC
    `).all() as TransferRow[];

    let processed = 0;

    for (const transfer of transfers) {
      const providerReference = String(transfer.provider_reference);
      const result = await provider.getStatus(providerReference);

      try {
        db.exec("BEGIN IMMEDIATE");

        const current = db.prepare(`
          SELECT *
          FROM transfers
          WHERE id = ?
        `).get(String(transfer.id)) as | TransferRow | undefined;

        if (!current) {
          db.exec("ROLLBACK");
          continue;
        }

        if (current.status !== "pending" && current.status !== "uncertain") {
          db.exec("ROLLBACK");
          continue;
        }

        if (result.status === "pending") {
          db.exec("ROLLBACK");
          continue;
        }

        const nextStatus = result.status === "succeeded" ? "succeeded" : "reversed";

        if (!isValidTransition(String(current.status), nextStatus)) {
          db.exec("ROLLBACK");
          continue;
        }

        const now = clock.now().toISOString();

        if (nextStatus === "reversed") {
          db.prepare(`
            UPDATE accounts
            SET balance = balance + ?
            WHERE id = ?
          `).run(Number(current.amount), String(current.debit_account_id));
        }

        const updated = db.prepare(`
          UPDATE transfers
          SET status = ?,
              updated_at = ?
          WHERE id = ?
            AND status IN ('pending', 'uncertain')
        `).run(nextStatus, now, String(current.id));

        if (Number(updated.changes) === 1) processed += 1;

        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore rollback errors.
        }

        console.error(`failed to reconcile transfer ${String(transfer.id)}`, error);
      }
    }

    res.json({ processed });
  });

  return app;
}



