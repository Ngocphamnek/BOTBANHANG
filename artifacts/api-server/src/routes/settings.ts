import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";

const router = Router();

/** GET /settings — trả về tất cả settings (token bị che) */
router.get("/settings", async (_req, res) => {
  const rows = await db.select().from(settingsTable);
  const map: Record<string, string> = {};
  for (const r of rows) {
    // Che token để không lộ qua network
    if (r.key === "botToken" || r.key === "gcmmoAccessToken" || r.key === "gcmmoRefreshToken") {
      map[r.key] = r.value ? "SET" : "";
    } else {
      map[r.key] = r.value;
    }
  }
  // Trả thêm trạng thái env token
  map._envBotToken = process.env.TELEGRAM_BOT_TOKEN ? "SET" : "";
  map._envGcmmoToken = process.env.GCMMO_ACCESS_TOKEN ? "SET" : "";
  res.json(map);
});

/** PATCH /settings — cập nhật một setting */
router.patch("/settings", async (req, res) => {
  const { key, value } = req.body as { key: string; value: string };
  if (!key || typeof value !== "string") {
    res.status(400).json({ error: "key và value là bắt buộc" });
    return;
  }

  await db
    .insert(settingsTable)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value, updatedAt: new Date() },
    });

  // Nếu đang cập nhật bot token → thử khởi động bot ngay
  if (key === "botToken" && value) {
    const { tryStartBot } = await import("../bot/manager.js");
    await tryStartBot(value);
  }

  // Nếu đang cập nhật GCMMO token → set vào bộ nhớ + trigger sync
  if (key === "gcmmoAccessToken" && value) {
    const { setGcmmoTokens, isTokenConfigured } = await import("../lib/gcmmo-api.js");
    await setGcmmoTokens(value);
    // Trigger auto-sync ngay lập tức
    const { startAutoSync, fullSync, lastSyncTime } = await import("../lib/gcmmo-sync.js");
    if (!lastSyncTime) {
      // Chưa sync lần nào → khởi động scheduler
      startAutoSync(30 * 60 * 1000);
    } else {
      // Đã chạy → sync thủ công ngay
      fullSync().catch(() => {});
    }
  }

  res.json({ ok: true });
});

/** GET /settings/bot-status — kiểm tra trạng thái bot */
router.get("/settings/bot-status", async (_req, res) => {
  const { getBotStatus } = await import("../bot/manager.js");
  res.json(getBotStatus());
});

/** GET /settings/gcmmo-status — kiểm tra trạng thái GCMMO token */
router.get("/settings/gcmmo-status", async (_req, res) => {
  const { isTokenConfigured } = await import("../lib/gcmmo-api.js");
  const configured = isTokenConfigured();

  // Kiểm tra source
  const envSet = !!process.env.GCMMO_ACCESS_TOKEN;
  const [dbRow] = await db.select().from(settingsTable).where(eq(settingsTable.key, "gcmmoAccessToken"));
  const dbSet = !!dbRow?.value;

  const { lastSyncTime, lastSyncResult } = await import("../lib/gcmmo-sync.js");
  res.json({
    configured,
    source: envSet ? "env" : dbSet ? "db" : "none",
    lastSyncTime: lastSyncTime?.toISOString() ?? null,
    lastSyncOk: lastSyncResult?.products.ok ?? null,
  });
});

export default router;
