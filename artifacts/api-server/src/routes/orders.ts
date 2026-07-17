import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import { db, ordersTable } from "@workspace/db";
import {
  GetOrderParams,
  UpdateOrderParams,
  UpdateOrderBody,
} from "@workspace/api-zod";

const router = Router();

function serializeOrder(o: typeof ordersTable.$inferSelect) {
  return {
    ...o,
    telegramUserId: Number(o.telegramUserId),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

// GET /orders/recent (must be before /orders/:id)
router.get("/orders/recent", async (_req, res) => {
  const rows = await db
    .select()
    .from(ordersTable)
    .orderBy(desc(ordersTable.createdAt))
    .limit(10);
  res.json(rows.map(serializeOrder));
});

// GET /orders
router.get("/orders", async (req, res) => {
  const { status, limit } = req.query as { status?: string; limit?: string };
  let query = db.select().from(ordersTable).$dynamic();
  if (status) query = query.where(eq(ordersTable.status, status as any));
  query = query.orderBy(desc(ordersTable.createdAt));
  if (limit) query = query.limit(Number(limit));
  const rows = await query;
  res.json(rows.map(serializeOrder));
});

// GET /orders/:id
router.get("/orders/:id", async (req, res) => {
  const parse = GetOrderParams.safeParse({ id: Number(req.params.id) });
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, parse.data.id));
  if (!order) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeOrder(order));
});

// PATCH /orders/:id
router.patch("/orders/:id", async (req, res) => {
  const paramsParse = UpdateOrderParams.safeParse({ id: Number(req.params.id) });
  const bodyParse = UpdateOrderBody.safeParse(req.body);
  if (!paramsParse.success || !bodyParse.success) { res.status(400).json({ error: "Invalid input" }); return; }

  const [updated] = await db
    .update(ordersTable)
    .set({ ...bodyParse.data, updatedAt: new Date() })
    .where(eq(ordersTable.id, paramsParse.data.id))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeOrder(updated));
});

export default router;
