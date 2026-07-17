import { Bot } from "grammy";
import { logger } from "../lib/logger.js";
import { setupBot } from "./index.js";

interface BotStatus {
  running: boolean;
  username?: string;
  source: "env" | "db" | "none";
}

let activeBotInstance: Bot | null = null;
let botStatus: BotStatus = { running: false, source: "none" };
let startingPromise: Promise<void> | null = null;

export function getBotStatus(): BotStatus {
  return { ...botStatus };
}

export function setInitialBot(bot: Bot | null, source: "env" | "db" | "none") {
  activeBotInstance = bot;
  if (bot) {
    botStatus = { running: true, source };
  }
}

export async function tryStartBot(token: string): Promise<{ ok: boolean; error?: string }> {
  if (startingPromise) {
    // Đang khởi động, chờ xong
    await startingPromise;
    return { ok: botStatus.running };
  }

  // Nếu đang chạy với token cũ, dừng trước
  if (activeBotInstance) {
    try {
      await activeBotInstance.stop();
    } catch (_) {}
    activeBotInstance = null;
    botStatus = { running: false, source: "none" };
  }

  const bot = new Bot(token);
  let resolve!: () => void;
  startingPromise = new Promise<void>((r) => { resolve = r; });

  try {
    // Kiểm tra token hợp lệ
    const me = await bot.api.getMe();
    setupBot(bot);
    bot.start({ drop_pending_updates: true }).catch((e) => {
      logger.error({ err: e }, "Bot stopped");
      botStatus = { running: false, source: "none" };
      activeBotInstance = null;
    });
    activeBotInstance = bot;
    botStatus = { running: true, username: me.username, source: "db" };
    logger.info({ username: me.username }, "Bot started via settings");
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err }, "Failed to start bot with provided token");
    botStatus = { running: false, source: "none" };
    return { ok: false, error: msg };
  } finally {
    startingPromise = null;
    resolve();
  }
}

/** Lấy bot đang chạy để gửi tin nhắn */
export function getActiveBot(): Bot | null {
  return activeBotInstance;
}
