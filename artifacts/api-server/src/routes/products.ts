import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { db, productsTable, inventoryItemsTable, settingsTable } from "@workspace/db";
import {
  CreateProductBody,
  UpdateProductBody,
  GetProductParams,
  DeleteProductParams,
  UpdateProductParams,
} from "@workspace/api-zod";
import { getMarketplaceProducts, getGcmmoProductLive, isTokenConfigured } from "../lib/gcmmo-api.js";

const router = Router();

// GET /products
router.get("/products", async (req, res) => {
  const rows = await db
    .select({
      id: productsTable.id,
      name: productsTable.name,
      description: productsTable.description,
      price: productsTable.price,
      gcmmoPrice: productsTable.gcmmoPrice,
      category: productsTable.category,
      sourceId: productsTable.sourceId,
      gcmmoVariantId: productsTable.gcmmoVariantId,
      gcmmoSellerId: productsTable.gcmmoSellerId,
      stock: productsTable.stock,
      imageUrl: productsTable.imageUrl,
      isActive: productsTable.isActive,
      createdAt: productsTable.createdAt,
      updatedAt: productsTable.updatedAt,
      inventoryCount: sql<number>`cast(count(${inventoryItemsTable.id}) filter (where ${inventoryItemsTable.status} = 'available') as int)`,
    })
    .from(productsTable)
    .leftJoin(inventoryItemsTable, eq(productsTable.id, inventoryItemsTable.productId))
    .groupBy(productsTable.id)
    .orderBy(productsTable.createdAt);

  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() })));
});

// GET /products/gcmmo-browse — lấy danh sách sản phẩm trực tiếp từ gcmmo marketplace
router.get("/products/gcmmo-browse", async (req, res) => {
  if (!isTokenConfigured()) {
    res.status(400).json({ error: "Chưa kết nối gcmmo.net — vào Cài đặt để thêm token" });
    return;
  }
  try {
    const { products, total } = await getMarketplaceProducts({ maxProducts: 500 });
    res.json({ products, total });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /products
router.post("/products", async (req, res) => {
  const parse = CreateProductBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message });
    return;
  }
  const { name, description, price, category, sourceId, imageUrl, isActive } = parse.data;
  const [product] = await db
    .insert(productsTable)
    .values({ name, description, price, category, sourceId, imageUrl, isActive: isActive ?? true })
    .returning();
  res.status(201).json({ ...product!, createdAt: product!.createdAt.toISOString(), updatedAt: product!.updatedAt.toISOString(), inventoryCount: 0 });
});

// GET /products/:id
router.get("/products/:id", async (req, res) => {
  const parse = GetProductParams.safeParse({ id: Number(req.params.id) });
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const rows = await db
    .select({
      id: productsTable.id,
      name: productsTable.name,
      description: productsTable.description,
      price: productsTable.price,
      gcmmoPrice: productsTable.gcmmoPrice,
      category: productsTable.category,
      sourceId: productsTable.sourceId,
      gcmmoVariantId: productsTable.gcmmoVariantId,
      gcmmoSellerId: productsTable.gcmmoSellerId,
      stock: productsTable.stock,
      imageUrl: productsTable.imageUrl,
      isActive: productsTable.isActive,
      createdAt: productsTable.createdAt,
      updatedAt: productsTable.updatedAt,
      inventoryCount: sql<number>`cast(count(${inventoryItemsTable.id}) filter (where ${inventoryItemsTable.status} = 'available') as int)`,
    })
    .from(productsTable)
    .leftJoin(inventoryItemsTable, eq(productsTable.id, inventoryItemsTable.productId))
    .where(eq(productsTable.id, parse.data.id))
    .groupBy(productsTable.id);

  if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...rows[0], createdAt: rows[0].createdAt.toISOString(), updatedAt: rows[0].updatedAt.toISOString() });
});

// GET /products/:id/gcmmo-live — lấy stock THỰC TẾ từ gcmmo.net (không qua cache)
router.get("/products/:id/gcmmo-live", async (req, res) => {
  const localId = Number(req.params.id);
  if (!localId) { res.status(400).json({ error: "Invalid id" }); return; }

  const product = await db.query.productsTable.findFirst({ where: eq(productsTable.id, localId) });
  if (!product) { res.status(404).json({ error: "Không tìm thấy sản phẩm" }); return; }
  if (!product.sourceId) { res.status(400).json({ error: "Sản phẩm này không liên kết gcmmo" }); return; }
  if (!isTokenConfigured()) { res.status(400).json({ error: "Chưa kết nối gcmmo.net" }); return; }

  try {
    const live = await getGcmmoProductLive(product.sourceId);

    // Cập nhật stock vào DB luôn để đồng bộ
    await db.update(productsTable).set({ stock: live.stock, updatedAt: new Date() }).where(eq(productsTable.id, localId));

    res.json({
      stock: live.stock,
      status: live.status,
      price: live.price,
      name: live.name,
      image_url: live.image_url,
      sold_count: live.sold_count,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /products/import-gcmmo — import sản phẩm được chọn từ gcmmo vào DB local
router.post("/products/import-gcmmo", async (req, res) => {
  if (!isTokenConfigured()) {
    res.status(400).json({ error: "Chưa kết nối gcmmo.net" });
    return;
  }
  const { productIds, markup = 0 } = req.body as { productIds: string[]; markup?: number };
  if (!Array.isArray(productIds) || productIds.length === 0) {
    res.status(400).json({ error: "productIds không hợp lệ" });
    return;
  }

  try {
    const { products } = await getMarketplaceProducts({ maxProducts: 500 });
    const selected = products.filter((p) => productIds.includes(p.id));

    let imported = 0;
    let updated = 0;

    for (const p of selected) {
      const gcmmoPrice = Math.round(p.price);
      const sellPrice = Math.round(gcmmoPrice * (1 + markup / 100));
      const ext = p as any;
      const gcmmoVariantId: string | null = ext.variants?.[0]?.id ?? null;
      const gcmmoSellerId: string | null = ext.seller_id ?? null;

      const existing = await db.query.productsTable.findFirst({
        where: eq(productsTable.sourceId, p.id),
      });

      if (existing) {
        await db.update(productsTable).set({
          name: p.name,
          gcmmoPrice,
          imageUrl: p.image_url ?? existing.imageUrl,
          description: p.description || existing.description,
          isActive: true,
          stock: p.stock,
          gcmmoVariantId,
          gcmmoSellerId,
          updatedAt: new Date(),
        }).where(eq(productsTable.id, existing.id));
        updated++;
      } else {
        await db.insert(productsTable).values({
          name: p.name,
          price: sellPrice,
          gcmmoPrice,
          category: p.category?.name ?? "Chung",
          sourceId: p.id,
          gcmmoVariantId,
          gcmmoSellerId,
          imageUrl: p.image_url ?? null,
          description: p.description || null,
          isActive: true,
          stock: p.stock,
        });
        imported++;
      }
    }

    res.json({ ok: true, imported, updated, total: imported + updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /products/:id
router.patch("/products/:id", async (req, res) => {
  const paramsParse = UpdateProductParams.safeParse({ id: Number(req.params.id) });
  const bodyParse = UpdateProductBody.safeParse(req.body);
  if (!paramsParse.success || !bodyParse.success) { res.status(400).json({ error: "Invalid input" }); return; }

  const [updated] = await db
    .update(productsTable)
    .set({ ...bodyParse.data, updatedAt: new Date() })
    .where(eq(productsTable.id, paramsParse.data.id))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }

  const [countRow] = await db
    .select({ c: sql<number>`cast(count(*) filter (where ${inventoryItemsTable.status} = 'available') as int)` })
    .from(inventoryItemsTable)
    .where(eq(inventoryItemsTable.productId, updated.id));

  res.json({ ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString(), inventoryCount: countRow?.c ?? 0 });
});

// DELETE /products/:id
router.delete("/products/:id", async (req, res) => {
  const parse = DeleteProductParams.safeParse({ id: Number(req.params.id) });
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(productsTable).where(eq(productsTable.id, parse.data.id));
  res.status(204).send();
});

// POST /products/:id/broadcast — gửi sản phẩm lên Telegram
router.post("/products/:id/broadcast", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  // Lấy sản phẩm
  const rows = await db
    .select({
      id: productsTable.id,
      name: productsTable.name,
      description: productsTable.description,
      price: productsTable.price,
      category: productsTable.category,
      imageUrl: productsTable.imageUrl,
      isActive: productsTable.isActive,
      inventoryCount: sql<number>`cast(count(${inventoryItemsTable.id}) filter (where ${inventoryItemsTable.status} = 'available') as int)`,
    })
    .from(productsTable)
    .leftJoin(inventoryItemsTable, eq(productsTable.id, inventoryItemsTable.productId))
    .where(eq(productsTable.id, id))
    .groupBy(productsTable.id);

  const product = rows[0];
  if (!product) { res.status(404).json({ error: "Không tìm thấy sản phẩm" }); return; }

  // Lấy bot đang chạy
  const { getActiveBot } = await import("../bot/manager.js");
  const activeBot = getActiveBot();
  if (!activeBot) {
    res.status(400).json({ error: "Bot chưa kết nối. Vào Cài đặt để thêm token." });
    return;
  }

  // Lấy chat ID từ body hoặc settings
  let chatId: string | number | undefined = req.body?.chatId;
  if (!chatId) {
    const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, "channelId"));
    chatId = row?.value;
  }
  if (!chatId) {
    res.status(400).json({ error: "Chưa cấu hình Channel ID. Vào Cài đặt để thiết lập." });
    return;
  }

  const formatVnd = (n: number) => n.toLocaleString("vi-VN") + "đ";
  const caption = [
    `🛍 <b>${product.name}</b>`,
    product.category ? `📂 Danh mục: ${product.category}` : "",
    `💰 Giá: <b>${formatVnd(product.price)}</b>`,
    `📦 Kho còn: <b>${product.inventoryCount}</b>`,
    product.description ? `\n📝 ${product.description}` : "",
  ].filter(Boolean).join("\n");

  try {
    if (product.imageUrl) {
      await activeBot.api.sendPhoto(chatId, product.imageUrl, {
        caption,
        parse_mode: "HTML",
      });
    } else {
      await activeBot.api.sendMessage(chatId, caption, { parse_mode: "HTML" });
    }
    res.json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message;
    res.status(500).json({ error: `Gửi Telegram thất bại: ${msg}` });
  }
});

export default router;
