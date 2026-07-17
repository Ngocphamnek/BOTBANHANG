import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, inventoryItemsTable } from "@workspace/db";
import {
  AddInventoryItemsParams,
  AddInventoryItemsBody,
  DeleteInventoryItemParams,
  GetProductInventoryParams,
} from "@workspace/api-zod";

const router = Router();

// GET /products/:id/inventory
router.get("/products/:id/inventory", async (req, res) => {
  const parse = GetProductInventoryParams.safeParse({ id: Number(req.params.id) });
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const items = await db
    .select()
    .from(inventoryItemsTable)
    .where(eq(inventoryItemsTable.productId, parse.data.id))
    .orderBy(inventoryItemsTable.createdAt);

  res.json(items.map((i) => ({
    ...i,
    createdAt: i.createdAt.toISOString(),
    soldAt: i.soldAt ? i.soldAt.toISOString() : null,
  })));
});

// POST /products/:id/inventory
router.post("/products/:id/inventory", async (req, res) => {
  const paramsParse = AddInventoryItemsParams.safeParse({ id: Number(req.params.id) });
  const bodyParse = AddInventoryItemsBody.safeParse(req.body);
  if (!paramsParse.success || !bodyParse.success) { res.status(400).json({ error: "Invalid input" }); return; }

  const { items } = bodyParse.data;
  const toInsert = items
    .map((s) => s.trim())
    .filter(Boolean)
    .map((content) => ({ productId: paramsParse.data.id, content, status: "available" as const }));

  if (toInsert.length === 0) { res.status(400).json({ error: "No items provided" }); return; }

  await db.insert(inventoryItemsTable).values(toInsert);
  res.status(201).json({ added: toInsert.length });
});

// DELETE /inventory/:id
router.delete("/inventory/:id", async (req, res) => {
  const parse = DeleteInventoryItemParams.safeParse({ id: Number(req.params.id) });
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(inventoryItemsTable).where(eq(inventoryItemsTable.id, parse.data.id));
  res.status(204).send();
});

export default router;
