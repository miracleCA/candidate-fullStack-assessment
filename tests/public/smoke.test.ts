import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { createDatabase, seedDatabase, type AppDatabase } from "../../src/server/db.js";
import { FakeProvider } from "../../src/server/provider.js";


describe("API", () => {
  let db: AppDatabase;
  let provider: FakeProvider;

  beforeEach(() => {
    db = createDatabase();
    seedDatabase(db);
    provider = new FakeProvider();
  });

  afterEach(() => {
    db.close();
  });

  describe("health", () => {
    it("starts and reports health", async () => {
      const response = await request(createApp({ db, provider })).get(
        "/api/health",
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    });
  });

  describe("authentication", () => {
    it("requires a demo identity on user routes", async () => {
      const response = await request(createApp({ db, provider })).get(
        "/api/accounts",
      );

      expect(response.status).toBe(401);
    });
  });

  describe("transfers", () => {
    it("can create a transfer on the happy path", async () => {
      const app = createApp({ db, provider });

      const response = await request(app)
        .post("/api/transfers")
        .set("x-demo-user", "user-a")
        .set("Idempotency-Key", "public-test-1")
        .send({
          debitAccountId: "acc-a",
          destinationAccount: "0123456789",
          amount: 10_000,
        });

      expect(response.status).toBe(201);

      expect(response.body).toMatchObject({
        amount: 10_000,
        debitAccountId: "acc-a",
        destinationAccount: "0123456789",
      });

      expect(response.body.id).toBeDefined();
    });

    it("can create and list a transfer", async () => {
      const app = createApp({ db, provider });

      const created = await request(app)
        .post("/api/transfers")
        .set("x-demo-user", "user-a")
        .set("Idempotency-Key", "list-test-1")
        .send({
          debitAccountId: "acc-a",
          destinationAccount: "0123456789",
          amount: 10_000,
        });

      expect(created.status).toBe(201);

      const listed = await request(app)
        .get("/api/transfers")
        .set("x-demo-user", "user-a");

      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);

      expect(listed.body[0]).toMatchObject({
        id: created.body.id,
        amount: 10_000,
        debitAccountId: "acc-a",
        destinationAccount: "0123456789",
      });
    });

    it("returns the existing transfer when the same idempotency key and request are reused", async () => {
      const app = createApp({ db, provider });

      const payload = {
        debitAccountId: "acc-a",
        destinationAccount: "0123456789",
        amount: 10_000,
      };

      const first = await request(app)
        .post("/api/transfers")
        .set("x-demo-user", "user-a")
        .set("Idempotency-Key", "idempotency-test-1")
        .send(payload);

      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/api/transfers")
        .set("x-demo-user", "user-a")
        .set("Idempotency-Key", "idempotency-test-1")
        .send(payload);

      expect(second.status).toBe(200);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.amount).toBe(first.body.amount);

      const listed = await request(app)
        .get("/api/transfers")
        .set("x-demo-user", "user-a");

      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
    });

    it("rejects reusing an idempotency key with a different request", async () => {
      const app = createApp({ db, provider });

      const first = await request(app)
        .post("/api/transfers")
        .set("x-demo-user", "user-a")
        .set("Idempotency-Key", "idempotency-conflict-1")
        .send({
          debitAccountId: "acc-a",
          destinationAccount: "0123456789",
          amount: 10_000,
        });

      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/api/transfers")
        .set("x-demo-user", "user-a")
        .set("Idempotency-Key", "idempotency-conflict-1")
        .send({
          debitAccountId: "acc-a",
          destinationAccount: "0123456789",
          amount: 20_000,
        });

      expect(second.status).toBe(409);

      const listed = await request(app)
        .get("/api/transfers")
        .set("x-demo-user", "user-a");

      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].amount).toBe(10_000);
    });

    it("requires an idempotency key when creating a transfer", async () => {
      const app = createApp({ db, provider });

      const response = await request(app)
        .post("/api/transfers")
        .set("x-demo-user", "user-a")
        .send({
          debitAccountId: "acc-a",
          destinationAccount: "0123456789",
          amount: 10_000,
        });

      expect(response.status).toBe(400);
    });

    it("requires a demo identity when creating a transfer", async () => {
      const app = createApp({ db, provider });

      const response = await request(app)
        .post("/api/transfers")
        .set("Idempotency-Key", "auth-test-1")
        .send({
          debitAccountId: "acc-a",
          destinationAccount: "0123456789",
          amount: 10_000,
        });

      expect(response.status).toBe(401);
    });

    it("rejects an invalid transfer amount", async () => {
      const app = createApp({ db, provider });

      const response = await request(app)
        .post("/api/transfers")
        .set("x-demo-user", "user-a")
        .set("Idempotency-Key", "validation-test-1")
        .send({
          debitAccountId: "acc-a",
          destinationAccount: "0123456789",
          amount: 0,
        });

      expect(response.status).toBe(400);
    });

    it("rejects a transfer from an account the user does not own", async () => {
      const app = createApp({ db, provider });

      const response = await request(app)
        .post("/api/transfers")
        .set("x-demo-user", "user-b")
        .set("Idempotency-Key", "ownership-test-1")
        .send({
          debitAccountId: "acc-a",
          destinationAccount: "0123456789",
          amount: 10_000,
        });

      expect(response.status).toBe(403);
    });
  });
});