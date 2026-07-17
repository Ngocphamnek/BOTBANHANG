import app from "./app.js";
import { logger } from "./lib/logger.js";
import { bot, setupBot } from "./bot/index.js";
import { setInitialBot } from "./bot/manager.js";
import { startAutoSync } from "./lib/gcmmo-sync.js";
import { isTokenConfigured, loadGcmmoTokensFromDb } from "./lib/gcmmo-api.js";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

app.listen(port, async (err) => {
  if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }
  logger.info({ port }, "Server listening");

  // ── Telegram Bot ───────────────────────────────────────────────────────────
  if (bot) {
    setupBot(bot);
    bot.start({ drop_pending_updates: true })
      .then(() => logger.info("Telegram bot started (long polling)"))
      .catch((e) => logger.error({ err: e }, "Telegram bot failed to start"));
    setInitialBot(bot, "env");
  } else {
    logger.warn("Telegram bot not started — TELEGRAM_BOT_TOKEN is not set");
    // Thử lấy token từ DB settings
    try {
      const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, "botToken"));
      if (row?.value) {
        const { tryStartBot } = await import("./bot/manager.js");
        const result = await tryStartBot(row.value);
        if (result.ok) logger.info("Telegram bot started from DB settings");
        else logger.warn({ error: result.error }, "DB bot token invalid");
      }
    } catch (e) {
      logger.warn({ err: e }, "Could not load bot token from DB");
    }
  }

  // ── GCMMO Token ────────────────────────────────────────────────────────────
  if (!isTokenConfigured()) {
    logger.info("GCMMO_ACCESS_TOKEN not in env — checking DB settings...");
    const loaded = await loadGcmmoTokensFromDb();
    if (loaded) {
      logger.info("GCMMO token loaded from DB settings");
    } else {
      logger.warn("GCMMO_ACCESS_TOKEN not set — auto-sync disabled");
    }
  }

  // Khởi động auto-sync nếu token đã có
  if (isTokenConfigured()) {
    startAutoSync(30 * 60 * 1000);
    logger.info("gcmmo auto-sync started (every 30 minutes)");
  }
});

process.once("SIGINT", () => bot?.stop());
process.once("SIGTERM", () => bot?.stop());
