import { Bot, InlineKeyboard } from "grammy";
import { eq, and, sql, desc } from "drizzle-orm";
import {
  db, productsTable, ordersTable, botUsersTable,
  inventoryItemsTable, settingsTable, walletTransactionsTable,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  isTokenConfigured,
  getSellerBalance,
  getDashboardSummary,
  buyGcmmoProduct,
  extractDeliveredContent,
  pollGcmmoOrderUntilDelivered,
  createGcmmoDeposit,
  getGcmmoDeposit,
  bankBinToName,
  type GcmmoDeposit,
} from "../lib/gcmmo-api.js";
import { fullSync, lastSyncTime, lastSyncResult, startAutoSync } from "../lib/gcmmo-sync.js";
import { tgAuthStart, tgAuthPoll, gcmmoLogin, type TgSession } from "../lib/tg-oauth.js";

// ─── ADMIN IDs ────────────────────────────────────────────────────────────────
const ADMIN_IDS: Set<number> = new Set(
  (process.env.ADMIN_TELEGRAM_IDS ?? "").split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n))
);
function isAdmin(userId: number) {
  return ADMIN_IDS.size === 0 || ADMIN_IDS.has(userId);
}

// ─── Connect flow state ───────────────────────────────────────────────────────
interface ConnectState {
  step: "waiting_phone" | "polling";
  session?: TgSession;
}
const connectStates = new Map<number, ConnectState>();

// ─── Top-up flow state: user đang nhập số tiền nạp ──────────────────────────
interface TopupInputState {
  step: "waiting_amount";
}
const topupInputStates = new Map<number, TopupInputState>(); // userId → state

// ─── Active deposit sessions: đang poll gcmmo để xác nhận ────────────────────
interface ActiveDeposit {
  depositId: string;
  amount: number;
  chatId: number;
  notifyMsgId?: number;  // ID tin nhắn thông báo để edit
  timeoutHandle: ReturnType<typeof setTimeout>;
}
const activeDeposits = new Map<number, ActiveDeposit>(); // userId → deposit

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");

export const bot: Bot | null = token ? new Bot(token) : null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatVnd(amount: number) {
  return amount.toLocaleString("vi-VN") + "đ";
}

async function upsertUser(from: { id: number; username?: string; first_name?: string; last_name?: string }) {
  await db
    .insert(botUsersTable)
    .values({
      telegramId: from.id,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      balance: 0,
    })
    .onConflictDoUpdate({
      target: botUsersTable.telegramId,
      set: { username: from.username ?? null, firstName: from.first_name ?? null },
    });
}

async function getUser(telegramId: number) {
  return db.query.botUsersTable.findFirst({ where: eq(botUsersTable.telegramId, telegramId) });
}

async function getSetting(key: string, fallback = ""): Promise<string> {
  const row = await db.query.settingsTable.findFirst({ where: eq(settingsTable.key, key) });
  return row?.value ?? fallback;
}

async function getAvailableCount(product: typeof productsTable.$inferSelect): Promise<number> {
  if (product.sourceId) return product.stock ?? 0;
  const [row] = await db
    .select({ c: sql<number>`cast(count(*) as int)` })
    .from(inventoryItemsTable)
    .where(and(eq(inventoryItemsTable.productId, product.id), eq(inventoryItemsTable.status, "available")));
  return row?.c ?? 0;
}

/**
 * Trừ tiền ví user và ghi log giao dịch (atomic trong JS — đủ dùng cho Telegram bot)
 * Returns false nếu không đủ số dư.
 */
async function deductBalance(
  telegramId: number,
  amount: number,
  note: string,
  orderId?: number,
): Promise<boolean> {
  const user = await getUser(telegramId);
  if (!user || user.balance < amount) return false;

  const balanceBefore = user.balance;
  const balanceAfter = balanceBefore - amount;

  await db.update(botUsersTable).set({ balance: balanceAfter }).where(eq(botUsersTable.telegramId, telegramId));
  await db.insert(walletTransactionsTable).values({
    telegramUserId: telegramId,
    type: "purchase",
    amount: -amount,
    balanceBefore,
    balanceAfter,
    note,
    orderId: orderId ?? null,
  });
  return true;
}

/**
 * Hoàn tiền khi đơn thất bại
 */
async function refundBalance(
  telegramId: number,
  amount: number,
  note: string,
  orderId?: number,
) {
  const user = await getUser(telegramId);
  if (!user) return;

  const balanceBefore = user.balance;
  const balanceAfter = balanceBefore + amount;

  await db.update(botUsersTable).set({ balance: balanceAfter }).where(eq(botUsersTable.telegramId, telegramId));
  await db.insert(walletTransactionsTable).values({
    telegramUserId: telegramId,
    type: "refund",
    amount,
    balanceBefore,
    balanceAfter,
    note,
    orderId: orderId ?? null,
  });
}

// ─── Nạp tiền — menu chọn số tiền ───────────────────────────────────────────
function buildTopupMenu() {
  return new InlineKeyboard()
    .text("20.000đ", "topup:20000").text("50.000đ", "topup:50000").text("100.000đ", "topup:100000").row()
    .text("200.000đ", "topup:200000").text("500.000đ", "topup:500000").text("1.000.000đ", "topup:1000000").row()
    .text("✏️ Nhập số tiền khác", "topup:custom").row()
    .text("🔙 Quay lại", "main:back");
}

/**
 * Tạo phiên nạp tiền gcmmo và gửi QR/bank info cho user.
 * editFn: hàm để edit tin nhắn gốc (inline callback) hoặc send tin mới
 */
async function doCreateDeposit(
  userId: number,
  chatId: number,
  amount: number,
  b: Bot,
  editFn: (text: string, kb: InlineKeyboard) => Promise<void>,
) {
  if (amount < 10_000 || amount > 10_000_000) {
    const kb = new InlineKeyboard().text("🔙 Chọn lại", "main:topup");
    await editFn(`❌ Số tiền không hợp lệ.\n💵 Tối thiểu: <b>10.000đ</b> — Tối đa: <b>10.000.000đ</b>`, kb);
    return;
  }

  const loadingKb = new InlineKeyboard().text("⏳ Đang tạo phiên...", "noop");
  await editFn(`⏳ <b>Đang tạo phiên nạp tiền...</b>\n\n💵 Số tiền: <b>${formatVnd(amount)}</b>`, loadingKb);

  let deposit: GcmmoDeposit;
  try {
    deposit = await createGcmmoDeposit(amount);
  } catch (err) {
    const kb = new InlineKeyboard().text("🔄 Thử lại", "main:topup").row().text("🔙 Menu", "main:back");
    await editFn(`❌ <b>Không thể tạo phiên nạp tiền</b>\n\n${(err as Error).message.slice(0, 150)}`, kb);
    return;
  }

  const bankName = bankBinToName(deposit.receive_bank_bin);
  const expiresIn = Math.round((new Date(deposit.expires_at).getTime() - Date.now()) / 60_000);

  const infoText =
    `💰 <b>Phiên nạp tiền</b>\n\n` +
    `💵 Số tiền: <b>${formatVnd(deposit.amount)}</b>\n` +
    `⏰ Hết hạn sau: <b>${expiresIn} phút</b>\n\n` +
    `🏦 Ngân hàng: <b>${bankName}</b>\n` +
    `📋 Số TK: <code>${deposit.receive_account_number}</code>\n` +
    `👤 Chủ TK: <b>${deposit.receive_account_name}</b>\n\n` +
    `📝 <b>Nội dung chuyển khoản:</b>\n<code>${deposit.transfer_content}</code>\n\n` +
    `✅ Hệ thống tự động xác nhận ngay khi nhận được tiền.\n` +
    `⚠️ Ghi đúng nội dung, sai nội dung tiền không vào ví.`;

  const kb = new InlineKeyboard()
    .text("🔄 Tạo phiên mới", "main:topup").row()
    .text("🔙 Menu chính", "main:back");

  // Gửi ảnh QR riêng
  try {
    await b.api.sendPhoto(chatId, deposit.qr_code_url, {
      caption: infoText,
      parse_mode: "HTML",
      reply_markup: kb,
    });
    // Edit tin nhắn gốc thành thông báo đã gửi QR
    await editFn(
      `📸 <b>Đã gửi mã QR bên dưới!</b>\n\n💵 Số tiền: <b>${formatVnd(deposit.amount)}</b>\n📝 Nội dung: <code>${deposit.transfer_content}</code>\n\n⏳ Đang theo dõi xác nhận tự động...`,
      new InlineKeyboard().text("🔄 Nạp lần nữa", "main:topup").row().text("🔙 Menu", "main:back")
    );
  } catch {
    // Nếu gửi ảnh lỗi → hiện text thôi
    await editFn(infoText, kb);
  }

  // Huỷ phiên cũ nếu đang có
  const existing = activeDeposits.get(userId);
  if (existing) {
    clearTimeout(existing.timeoutHandle);
    activeDeposits.delete(userId);
  }

  // Bắt đầu poll ngầm
  const POLL_INTERVAL = 12_000;  // 12 giây
  const TIMEOUT_MS = Math.max(expiresIn * 60_000, 15 * 60_000); // ít nhất 15 phút

  const timeoutHandle = setTimeout(() => {
    activeDeposits.delete(userId);
    // Thông báo hết hạn
    b.api.sendMessage(chatId,
      `⏰ <b>Phiên nạp tiền đã hết hạn</b>\n\n📝 Mã: <code>${deposit.transfer_content}</code>\n💵 Số tiền: ${formatVnd(deposit.amount)}\n\nNếu bạn đã chuyển, liên hệ admin để được hỗ trợ.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("💰 Tạo phiên mới", "main:topup") }
    ).catch(() => {});
  }, TIMEOUT_MS);

  activeDeposits.set(userId, { depositId: deposit.id, amount: deposit.amount, chatId, timeoutHandle });

  // Poll loop
  const pollDeposit = async () => {
    const active = activeDeposits.get(userId);
    if (!active || active.depositId !== deposit.id) return; // bị huỷ hoặc thay thế

    try {
      const latest = await getGcmmoDeposit(deposit.id);

      if (latest.status === "completed") {
        clearTimeout(active.timeoutHandle);
        activeDeposits.delete(userId);

        // Cộng ví cho user
        const user = await getUser(userId);
        if (!user) return;
        const balanceBefore = user.balance;
        const balanceAfter = balanceBefore + deposit.amount;
        await db.update(botUsersTable).set({ balance: balanceAfter }).where(eq(botUsersTable.telegramId, userId));
        await db.insert(walletTransactionsTable).values({
          telegramUserId: userId,
          type: "deposit",
          amount: deposit.amount,
          balanceBefore,
          balanceAfter,
          note: `Nạp qua gcmmo — ${deposit.transfer_content}`,
        });

        await b.api.sendMessage(chatId,
          `🎉 <b>Nạp tiền thành công!</b>\n\n` +
          `⬆️ Đã nhận: <b>${formatVnd(deposit.amount)}</b>\n` +
          `💳 Số dư mới: <b>${formatVnd(balanceAfter)}</b>\n\n` +
          `🛍️ Bạn có thể mua hàng ngay!`,
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🛍️ Mua hàng ngay", "main:shop").row().text("🏠 Menu chính", "main:back") }
        );
        return;
      }

      if (latest.status === "expired" || latest.status === "cancelled") {
        clearTimeout(active.timeoutHandle);
        activeDeposits.delete(userId);
        return;
      }

      // Vẫn pending → poll tiếp
      setTimeout(pollDeposit, POLL_INTERVAL);
    } catch {
      // Lỗi mạng tạm thời → poll tiếp
      setTimeout(pollDeposit, POLL_INTERVAL * 2);
    }
  };

  // Bắt đầu poll sau 15 giây (chờ user chuyển khoản)
  setTimeout(pollDeposit, 15_000);
}

// ─── Menu chính ──────────────────────────────────────────────────────────────
function buildMainMenu() {
  return new InlineKeyboard()
    .text("🛍️ Danh sách sản phẩm", "main:shop").row()
    .text("💰 Nạp tiền", "main:topup").text("👤 Hồ sơ", "main:profile").row()
    .text("📋 Lịch sử mua hàng", "main:history").text("🆘 Hỗ trợ", "main:support");
}

// Cache tên danh mục → index ngắn để dùng trong callback data (tránh emoji dài)
const CAT_KEY_MAP = new Map<string, string>(); // full cat name → short key "c0", "c1", ...
const CAT_IDX_MAP = new Map<string, string>(); // short key → full cat name

/**
 * Đọc ngưỡng lọc chất lượng shop từ settings.
 * - min_seller_reviews: số lượt đánh giá tối thiểu (default 0 = không lọc)
 * - min_seller_rating:  rating tối thiểu x10 (default 0 = không lọc)
 * - min_seller_sold:    đơn hoàn thành tối thiểu (default 0 = không lọc)
 */
async function getSellerQualityFilter(): Promise<{
  minReviews: number; minRating: number; minSold: number;
}> {
  const [r, ra, s] = await Promise.all([
    getSetting("min_seller_reviews", "0"),
    getSetting("min_seller_rating", "0"),
    getSetting("min_seller_sold", "0"),
  ]);
  return {
    minReviews: parseInt(r) || 0,
    minRating: parseInt(ra) || 0,   // stored as rating*10 (e.g. 40 = 4.0 sao)
    minSold: parseInt(s) || 0,
  };
}

/**
 * Lọc danh sách sản phẩm theo chất lượng shop.
 * Nếu sản phẩm chưa có dữ liệu shop (sellerReviewCount = null)
 * nhưng ngưỡng = 0 → vẫn hiện (không phạt hàng cũ chưa cập nhật).
 */
function applySellerQualityFilter(
  products: Array<typeof productsTable.$inferSelect>,
  filter: { minReviews: number; minRating: number; minSold: number }
): Array<typeof productsTable.$inferSelect> {
  const { minReviews, minRating, minSold } = filter;
  if (!minReviews && !minRating && !minSold) return products; // tắt lọc
  return products.filter((p) => {
    // Sản phẩm không phải từ gcmmo → luôn hiện (hàng thủ công)
    if (!p.sourceId) return true;
    const reviews = p.sellerReviewCount ?? 0;
    const rating = p.sellerRating ?? 0;   // *10
    const sold = p.sellerSoldCount ?? 0;
    if (minReviews > 0 && reviews < minReviews) return false;
    if (minRating > 0 && rating < minRating) return false;
    if (minSold > 0 && sold < minSold) return false;
    return true;
  });
}

async function buildCategoryMenu(): Promise<InlineKeyboard | null> {
  const filter = await getSellerQualityFilter();
  const allProducts = await db.select().from(productsTable).where(eq(productsTable.isActive, true));
  const products = applySellerQualityFilter(allProducts, filter);
  if (products.length === 0) return null;

  const catCount: Record<string, number> = {};
  for (const p of products) {
    const cat = p.category ?? "📦 Khác";
    catCount[cat] = (catCount[cat] ?? 0) + 1;
  }
  const categories = Object.entries(catCount)
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat);

  // Rebuild mapping
  CAT_KEY_MAP.clear();
  CAT_IDX_MAP.clear();
  categories.forEach((cat, i) => {
    const key = `c${i}`;
    CAT_KEY_MAP.set(cat, key);
    CAT_IDX_MAP.set(key, cat);
  });

  const kb = new InlineKeyboard();
  let col = 0;
  for (const cat of categories) {
    const key = CAT_KEY_MAP.get(cat)!;
    kb.text(`${cat} (${catCount[cat]})`, `cat:${key}`);
    col++;
    if (col % 2 === 0) kb.row();
  }
  if (col % 2 !== 0) kb.row();
  kb.text("🛒 Tất cả sản phẩm", "cat:all").row();
  kb.text("🔙 Menu chính", "main:back");
  return kb;
}

// ─── /start ──────────────────────────────────────────────────────────────────
export function setupBot(b: Bot) {
  b.command("start", async (ctx) => {
    if (ctx.from) await upsertUser(ctx.from);
    const user = ctx.from ? await getUser(ctx.from.id) : null;
    const name = ctx.from?.first_name ?? "bạn";
    const balanceText = user ? `\n💰 Số dư ví: <b>${formatVnd(user.balance)}</b>` : "";

    await ctx.reply(
      `👋 Chào mừng <b>${name}</b> đến với <b>GC MMO Shop</b>!${balanceText}\n\nChọn chức năng bên dưới:`,
      { parse_mode: "HTML", reply_markup: buildMainMenu() }
    );
  });

  // ─── Menu chính callbacks ─────────────────────────────────────────────────
  b.callbackQuery("main:back", async (ctx) => {
    if (ctx.from) await upsertUser(ctx.from);
    const user = ctx.from ? await getUser(ctx.from.id) : null;
    const name = ctx.from?.first_name ?? "bạn";
    const balanceText = user ? `\n💰 Số dư ví: <b>${formatVnd(user.balance)}</b>` : "";
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `👋 Chào <b>${name}</b>!${balanceText}\n\nChọn chức năng:`,
      { parse_mode: "HTML", reply_markup: buildMainMenu() }
    );
  });

  // ── 🛍️ Danh sách sản phẩm ────────────────────────────────────────────────
  b.callbackQuery("main:shop", async (ctx) => {
    if (ctx.from) await upsertUser(ctx.from);
    const kb = await buildCategoryMenu();
    if (!kb) { await ctx.answerCallbackQuery("Chưa có sản phẩm nào"); return; }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🛍️ <b>Chọn danh mục sản phẩm:</b>", { parse_mode: "HTML", reply_markup: kb });
  });

  // ── 💰 Nạp tiền — chọn số tiền ───────────────────────────────────────────
  b.callbackQuery("main:topup", async (ctx) => {
    if (!ctx.from) return;
    await upsertUser(ctx.from);
    await ctx.answerCallbackQuery();

    if (!isTokenConfigured()) {
      const kb = new InlineKeyboard().text("🔙 Quay lại", "main:back");
      await ctx.editMessageText("⚠️ Hệ thống nạp tiền chưa sẵn sàng. Vui lòng liên hệ admin.", { parse_mode: "HTML", reply_markup: kb });
      return;
    }

    // Xoá phiên cũ nếu đang nhập
    topupInputStates.delete(ctx.from.id);

    const user = await getUser(ctx.from.id);
    const balance = user?.balance ?? 0;

    const kb = new InlineKeyboard()
      .text("20.000đ", "topup:20000").text("50.000đ", "topup:50000").text("100.000đ", "topup:100000").row()
      .text("200.000đ", "topup:200000").text("500.000đ", "topup:500000").text("1.000.000đ", "topup:1000000").row()
      .text("✏️ Nhập số tiền khác", "topup:custom").row()
      .text("🔙 Quay lại", "main:back");

    await ctx.editMessageText(
      `💰 <b>Nạp tiền vào ví</b>\n\n` +
      `💳 Số dư hiện tại: <b>${formatVnd(balance)}</b>\n\n` +
      `Chọn số tiền muốn nạp hoặc nhập tùy ý.\n` +
      `✅ Hệ thống tự động xác nhận qua QR/chuyển khoản — <b>không cần chờ admin.</b>`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  });

  // ── Chọn số tiền preset → tạo phiên nạp gcmmo ─────────────────────────────
  b.callbackQuery(/^topup:(\d+)$/, async (ctx) => {
    if (!ctx.from) return;
    const amount = parseInt(ctx.match[1] as string);
    await ctx.answerCallbackQuery("Đang tạo phiên nạp tiền...");
    await doCreateDeposit(ctx.from.id, ctx.chat!.id, amount, b, async (text, kb) => {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    });
  });

  // ── Nhập số tiền tùy ý ────────────────────────────────────────────────────
  b.callbackQuery("topup:custom", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    topupInputStates.set(ctx.from.id, { step: "waiting_amount" });
    const kb = new InlineKeyboard().text("❌ Hủy", "topup:cancel");
    await ctx.editMessageText(
      `💰 <b>Nạp tiền — nhập số tiền</b>\n\n` +
      `Nhập số tiền muốn nạp vào chat này (VNĐ).\n` +
      `Ví dụ: <code>75000</code> hoặc <code>250000</code>\n\n` +
      `Tối thiểu: <b>10.000đ</b> — Tối đa: <b>10.000.000đ</b>`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  });

  b.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  b.callbackQuery("topup:cancel", async (ctx) => {
    if (!ctx.from) return;
    topupInputStates.delete(ctx.from.id);
    await ctx.answerCallbackQuery("Đã hủy");
    await ctx.editMessageText(
      "💰 <b>Nạp tiền vào ví</b>\n\nChọn số tiền muốn nạp:",
      { parse_mode: "HTML", reply_markup: buildTopupMenu() }
    );
  });

  // ── 👤 Hồ sơ ─────────────────────────────────────────────────────────────
  b.callbackQuery("main:profile", async (ctx) => {
    if (!ctx.from) return;
    await upsertUser(ctx.from);
    await ctx.answerCallbackQuery();

    const user = await getUser(ctx.from.id);
    const [orderCount, totalSpent] = await Promise.all([
      db.select({ c: sql<number>`cast(count(*) as int)` })
        .from(ordersTable)
        .where(and(eq(ordersTable.telegramUserId, ctx.from.id), eq(ordersTable.status, "delivered"))),
      db.select({ s: sql<number>`coalesce(cast(sum(total_price) as int), 0)` })
        .from(ordersTable)
        .where(and(eq(ordersTable.telegramUserId, ctx.from.id), eq(ordersTable.status, "delivered"))),
    ]);

    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
    const username = ctx.from.username ? `@${ctx.from.username}` : "Không có";
    const joinDate = user?.createdAt ? new Date(user.createdAt).toLocaleDateString("vi-VN") : "—";

    const kb = new InlineKeyboard()
      .text("📋 Lịch sử giao dịch ví", "wallet:history").row()
      .text("🔙 Quay lại", "main:back");

    await ctx.editMessageText(
      `👤 <b>Hồ sơ của bạn</b>\n\n` +
      `👤 Tên: <b>${name || "Không có"}</b>\n` +
      `🔖 Username: ${username}\n` +
      `🆔 Telegram ID: <code>${ctx.from.id}</code>\n` +
      `📅 Ngày tham gia: ${joinDate}\n\n` +
      `💰 <b>Số dư ví: ${formatVnd(user?.balance ?? 0)}</b>\n\n` +
      `📦 Đơn đã giao: <b>${orderCount[0]?.c ?? 0}</b>\n` +
      `💸 Tổng chi tiêu: <b>${formatVnd(totalSpent[0]?.s ?? 0)}</b>`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  });

  // ── 📋 Lịch sử mua hàng ──────────────────────────────────────────────────
  b.callbackQuery("main:history", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();

    const orders = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.telegramUserId, ctx.from.id))
      .orderBy(desc(ordersTable.createdAt))
      .limit(10);

    const kb = new InlineKeyboard().text("🔙 Quay lại", "main:back");

    if (orders.length === 0) {
      await ctx.editMessageText(
        "📋 <b>Lịch sử mua hàng</b>\n\nBạn chưa có đơn hàng nào.\n\nNhấn 🛍️ Danh sách để mua hàng!",
        { parse_mode: "HTML", reply_markup: kb }
      );
      return;
    }

    const statusLabel: Record<string, string> = {
      pending_payment: "⏳ Chờ TT",
      paid: "✅ Đã TT",
      delivered: "📦 Đã giao",
      cancelled: "❌ Hủy",
    };

    const lines = orders.map((o) => {
      const date = new Date(o.createdAt).toLocaleDateString("vi-VN");
      const status = statusLabel[o.status] ?? o.status;
      const name = (o.productName ?? "—").slice(0, 28);
      return `#${o.id} ${status} — <b>${formatVnd(o.totalPrice)}</b>\n📦 ${name} — ${date}`;
    });

    await ctx.editMessageText(
      `📋 <b>Lịch sử mua hàng</b> (10 gần nhất)\n\n${lines.join("\n\n")}`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  });

  // ── 🆘 Hỗ trợ ─────────────────────────────────────────────────────────────
  b.callbackQuery("main:support", async (ctx) => {
    await ctx.answerCallbackQuery();
    const supportContact = await getSetting("support_contact", "@admin");
    const supportNote = await getSetting("support_note", "Liên hệ admin qua username bên trên để được hỗ trợ.");

    const kb = new InlineKeyboard().text("🔙 Quay lại", "main:back");
    await ctx.editMessageText(
      `🆘 <b>Hỗ trợ khách hàng</b>\n\n` +
      `📞 Liên hệ: <b>${supportContact}</b>\n\n` +
      `📝 ${supportNote}\n\n` +
      `⏰ Giờ hỗ trợ: 8:00 — 22:00 hàng ngày`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  });

  // ── 📊 Lịch sử giao dịch ví ──────────────────────────────────────────────
  b.callbackQuery("wallet:history", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();

    const txs = await db
      .select()
      .from(walletTransactionsTable)
      .where(eq(walletTransactionsTable.telegramUserId, ctx.from.id))
      .orderBy(desc(walletTransactionsTable.createdAt))
      .limit(10);

    const kb = new InlineKeyboard()
      .text("🔙 Hồ sơ", "main:profile");

    if (txs.length === 0) {
      await ctx.editMessageText(
        "📊 <b>Lịch sử giao dịch ví</b>\n\nChưa có giao dịch nào.",
        { parse_mode: "HTML", reply_markup: kb }
      );
      return;
    }

    const typeLabel: Record<string, string> = {
      deposit: "⬆️ Nạp tiền",
      purchase: "⬇️ Mua hàng",
      refund: "↩️ Hoàn tiền",
      adjustment: "🔧 Điều chỉnh",
    };

    const lines = txs.map((t) => {
      const date = new Date(t.createdAt).toLocaleDateString("vi-VN");
      const sign = t.amount > 0 ? "+" : "";
      return `${typeLabel[t.type] ?? t.type}\n${sign}${formatVnd(Math.abs(t.amount))} → Dư: ${formatVnd(t.balanceAfter)}\n${t.note ? `📝 ${t.note} — ` : ""}${date}`;
    });

    await ctx.editMessageText(
      `📊 <b>Lịch sử giao dịch ví</b> (10 gần nhất)\n\n${lines.join("\n\n")}`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  });

  // ─── Browse danh mục (phân trang) ─────────────────────────────────────────
  // Format: cat:all, cat:c0, cat:c1, ... với phân trang: cat:all:1, cat:c0:2, ...
  b.callbackQuery(/^cat:([\w]+)(?::(\d+))?$/, async (ctx) => {
    if (ctx.from) await upsertUser(ctx.from);
    const catKey = ctx.match[1] as string;          // "all" hoặc "c0", "c1", ...
    const page = parseInt(ctx.match[2] ?? "0");
    const PAGE_SIZE = 8;

    // Resolve key → tên danh mục đầy đủ
    const catName = catKey === "all" ? null : (CAT_IDX_MAP.get(catKey) ?? catKey);

    const [allProducts, filter] = await Promise.all([
      db.select().from(productsTable).where(eq(productsTable.isActive, true)),
      getSellerQualityFilter(),
    ]);
    const products = applySellerQualityFilter(allProducts, filter);
    // Nếu key không tìm thấy trong map (server restart) → rebuild
    if (catKey !== "all" && !catName) {
      // Rebuild map bằng cách gọi buildCategoryMenu một lần
      await buildCategoryMenu();
    }
    const resolvedName = catKey === "all" ? null : (CAT_IDX_MAP.get(catKey) ?? null);
    const filtered = resolvedName === null ? products : products.filter((p) => p.category === resolvedName);

    if (filtered.length === 0) {
      await ctx.answerCallbackQuery("Không có sản phẩm nào");
      return;
    }

    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    const kb = new InlineKeyboard();
    for (const p of slice) {
      const label = p.name.length > 30 ? p.name.slice(0, 28) + "…" : p.name;
      kb.text(`${label} — ${formatVnd(p.price)}`, `prod:${p.id}`).row();
    }

    const navRow: Array<{ text: string; callback_data: string }> = [];
    if (page > 0) navRow.push({ text: "◀️ Trước", callback_data: `cat:${catKey}:${page - 1}` });
    if (page < totalPages - 1) navRow.push({ text: "Tiếp ▶️", callback_data: `cat:${catKey}:${page + 1}` });
    if (navRow.length > 0) {
      for (const btn of navRow) kb.text(btn.text, btn.callback_data);
      kb.row();
    }
    kb.text("📂 Danh mục", "main:shop").text("🏠 Menu", "main:back");

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `📦 <b>Sản phẩm${resolvedName ? ` — ${resolvedName}` : ""}:</b>\n` +
      `<i>Trang ${page + 1}/${totalPages} (${filtered.length} sản phẩm)</i>`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  });

  // ─── Chi tiết sản phẩm ────────────────────────────────────────────────────
  b.callbackQuery(/^prod:(\d+)$/, async (ctx) => {
    if (!ctx.from) return;
    await upsertUser(ctx.from);
    const productId = parseInt(ctx.match[1] as string);
    const [product, user] = await Promise.all([
      db.query.productsTable.findFirst({ where: eq(productsTable.id, productId) }),
      getUser(ctx.from.id),
    ]);
    if (!product) { await ctx.answerCallbackQuery("Sản phẩm không tồn tại"); return; }

    const available = await getAvailableCount(product);
    const balance = user?.balance ?? 0;
    const canAfford = balance >= product.price;

    let msg =
      `🛍️ <b>${product.name}</b>\n\n` +
      `💰 Giá: <b>${formatVnd(product.price)}</b>\n` +
      (product.description ? `📝 ${product.description}\n` : "") +
      `📦 Còn lại: <b>${available > 0 ? available : "Hết hàng"}</b>\n\n` +
      `💳 Số dư ví của bạn: <b>${formatVnd(balance)}</b>\n`;

    if (available <= 0) {
      msg += "\n⚠️ Tạm hết hàng, vui lòng quay lại sau.";
    } else if (!canAfford) {
      msg += `\n❌ Số dư không đủ (cần thêm <b>${formatVnd(product.price - balance)}</b>)\n💡 Nhấn <b>Nạp tiền</b> để tiếp tục.`;
    } else {
      msg += "\nNhấn <b>Mua ngay</b> để đặt hàng:";
    }

    const kb = new InlineKeyboard();
    if (available > 0 && canAfford) {
      kb.text("🛒 Mua ngay", `buy:${productId}`).row();
    } else if (available > 0 && !canAfford) {
      kb.text("💰 Nạp tiền ngay", "main:topup").row();
    }
    kb.text("🔙 Quay lại", "cat:all");

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: kb });
  });

  // ─── Mua sản phẩm (Wallet + Middleman Flow) ───────────────────────────────
  b.callbackQuery(/^buy:(\d+)$/, async (ctx) => {
    if (!ctx.from) return;
    await upsertUser(ctx.from);
    const productId = parseInt(ctx.match[1] as string);

    const [product, user] = await Promise.all([
      db.query.productsTable.findFirst({ where: eq(productsTable.id, productId) }),
      getUser(ctx.from.id),
    ]);

    if (!product) { await ctx.answerCallbackQuery("Sản phẩm không còn tồn tại"); return; }

    // Kiểm tra số dư ví
    const balance = user?.balance ?? 0;
    if (balance < product.price) {
      await ctx.answerCallbackQuery("❌ Số dư không đủ!", { show_alert: true });
      const kb = new InlineKeyboard().text("💰 Nạp tiền ngay", "main:topup").row().text("🔙 Quay lại", "cat:all");
      await ctx.editMessageText(
        `❌ <b>Số dư không đủ!</b>\n\n` +
        `💳 Số dư hiện tại: <b>${formatVnd(balance)}</b>\n` +
        `💰 Giá sản phẩm: <b>${formatVnd(product.price)}</b>\n` +
        `📉 Cần nạp thêm: <b>${formatVnd(product.price - balance)}</b>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
      return;
    }

    await ctx.answerCallbackQuery("Đang xử lý...");

    // ── Sản phẩm gcmmo → mua tự động qua gcmmo (middleman) ──────────────────
    if (product.sourceId) {
      if (!isTokenConfigured()) {
        await ctx.editMessageText("⚠️ Bot chưa kết nối gcmmo.net — liên hệ admin để kích hoạt.", { parse_mode: "HTML" });
        return;
      }
      if ((product.stock ?? 0) <= 0) {
        await ctx.editMessageText("😔 Sản phẩm này tạm hết hàng. Vui lòng thử lại sau.", { parse_mode: "HTML" });
        return;
      }

      // Tạo đơn PENDING
      const [pendingOrder] = await db.insert(ordersTable).values({
        telegramUserId: ctx.from.id,
        telegramUsername: ctx.from.username ?? null,
        productId,
        productName: product.name,
        quantity: 1,
        totalPrice: product.price,
        status: "pending_payment",
        source: "bot",
      }).returning();

      // Trừ tiền ví ngay (lock số tiền)
      const deducted = await deductBalance(
        ctx.from.id,
        product.price,
        `Mua: ${product.name.slice(0, 50)}`,
        pendingOrder!.id,
      );
      if (!deducted) {
        await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, pendingOrder!.id));
        await ctx.editMessageText("❌ Số dư không đủ (đã thay đổi trong lúc xử lý). Vui lòng thử lại.", { parse_mode: "HTML" });
        return;
      }

      await ctx.editMessageText(
        `⏳ <b>Đang đặt hàng tự động...</b>\n\n` +
        `📦 ${product.name}\n💰 ${formatVnd(product.price)}\n\n` +
        `🔄 Bot đang mua hàng từ nhà cung cấp, vui lòng chờ...`,
        { parse_mode: "HTML" }
      );

      try {
        const gcmmoOrder = await buyGcmmoProduct({
          productId: product.sourceId,
          variantId: product.gcmmoVariantId ?? undefined,
          quantity: 1,
        });

        await db.update(ordersTable)
          .set({ gcmmoOrderId: gcmmoOrder.id, updatedAt: new Date() })
          .where(eq(ordersTable.id, pendingOrder!.id));

        let deliveredContent = extractDeliveredContent(gcmmoOrder);

        if (deliveredContent.length === 0 && gcmmoOrder.status !== "cancelled") {
          await ctx.editMessageText(
            `⏳ <b>Đang chờ nhà cung cấp giao hàng...</b>\n\n` +
            `📦 ${product.name}\n🔄 Thường mất 10-60 giây...`,
            { parse_mode: "HTML" }
          );
          const polled = await pollGcmmoOrderUntilDelivered(gcmmoOrder.id, { timeoutMs: 120_000, intervalMs: 5_000 });
          if (polled) deliveredContent = polled.content;
        }

        if (gcmmoOrder.status === "cancelled" || deliveredContent.length === 0) {
          // Hoàn tiền vì đơn thất bại
          await refundBalance(ctx.from.id, product.price, `Hoàn tiền: đơn #${pendingOrder!.id} thất bại`, pendingOrder!.id);
          await db.update(ordersTable).set({ status: "cancelled", updatedAt: new Date() }).where(eq(ordersTable.id, pendingOrder!.id));
          const userAfter = await getUser(ctx.from.id);
          await ctx.editMessageText(
            `❌ <b>Đặt hàng thất bại!</b>\n\n` +
            `Nhà cung cấp không thể xử lý đơn này lúc này.\n` +
            `↩️ Đã hoàn lại <b>${formatVnd(product.price)}</b> vào ví.\n` +
            `💳 Số dư hiện tại: <b>${formatVnd(userAfter?.balance ?? 0)}</b>\n\n` +
            `🆔 Mã tham chiếu: #${pendingOrder!.id}`,
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🏠 Menu chính", "main:back") }
          );
          return;
        }

        const contentJson = JSON.stringify(deliveredContent);
        await db.update(ordersTable)
          .set({ status: "delivered", deliveredItems: contentJson, updatedAt: new Date() })
          .where(eq(ordersTable.id, pendingOrder!.id));

        await db.update(productsTable)
          .set({ stock: Math.max(0, (product.stock ?? 1) - 1), updatedAt: new Date() })
          .where(eq(productsTable.id, productId));

        const userAfter = await getUser(ctx.from.id);
        const contentText = deliveredContent.map((c, i) => deliveredContent.length > 1 ? `[${i + 1}] ${c}` : c).join("\n\n");

        await ctx.editMessageText(
          `✅ <b>Đặt hàng thành công!</b>\n\n` +
          `📦 Sản phẩm: <b>${product.name}</b>\n` +
          `💰 Đã thanh toán: <b>${formatVnd(product.price)}</b>\n` +
          `💳 Số dư còn lại: <b>${formatVnd(userAfter?.balance ?? 0)}</b>\n` +
          `🆔 Mã đơn: #${pendingOrder!.id}\n\n` +
          `⬇️ Thông tin sản phẩm đã gửi bên dưới 👇`,
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🏠 Menu chính", "main:back") }
        );

        await ctx.reply(
          `🔑 <b>Thông tin sản phẩm của bạn:</b>\n\n<code>${contentText}</code>\n\n` +
          `💡 Nhấn vào nội dung trên để sao chép nhanh.`,
          { parse_mode: "HTML" }
        );

      } catch (err) {
        const errMsg = (err as Error).message;
        logger.error({ err, productId, gcmmoSourceId: product.sourceId }, "Middleman buy failed");
        // Hoàn tiền
        await refundBalance(ctx.from.id, product.price, `Hoàn tiền: lỗi đơn #${pendingOrder!.id}`, pendingOrder!.id);
        await db.update(ordersTable).set({ status: "cancelled", updatedAt: new Date() }).where(eq(ordersTable.id, pendingOrder!.id));
        const userAfter = await getUser(ctx.from.id);
        await ctx.editMessageText(
          `❌ <b>Lỗi khi đặt hàng!</b>\n\n` +
          `${errMsg.includes("token") ? "⚠️ Kết nối gcmmo lỗi — liên hệ admin." : errMsg.slice(0, 200)}\n\n` +
          `↩️ Đã hoàn lại <b>${formatVnd(product.price)}</b> vào ví.\n` +
          `💳 Số dư hiện tại: <b>${formatVnd(userAfter?.balance ?? 0)}</b>\n` +
          `🆔 Mã tham chiếu: #${pendingOrder!.id}`,
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🏠 Menu chính", "main:back") }
        );
      }
      return;
    }

    // ── Sản phẩm nội bộ → kho local ─────────────────────────────────────────
    const [item] = await db
      .select().from(inventoryItemsTable)
      .where(and(eq(inventoryItemsTable.productId, productId), eq(inventoryItemsTable.status, "available")))
      .limit(1);

    if (!item) {
      await ctx.editMessageText("😔 Hết hàng rồi bạn ơi! Vui lòng thử lại sau.", { parse_mode: "HTML" });
      return;
    }

    // Tạo đơn + trừ tiền ví
    const [order] = await db.insert(ordersTable).values({
      telegramUserId: ctx.from.id,
      telegramUsername: ctx.from.username ?? null,
      productId,
      productName: product.name,
      quantity: 1,
      totalPrice: product.price,
      status: "delivered",
      deliveredItems: JSON.stringify([item.content]),
      source: "bot",
    }).returning();

    await db.update(inventoryItemsTable).set({ status: "sold", soldAt: new Date() }).where(eq(inventoryItemsTable.id, item.id));
    await deductBalance(ctx.from.id, product.price, `Mua: ${product.name.slice(0, 50)}`, order!.id);

    const userAfter = await getUser(ctx.from.id);
    await ctx.editMessageText(
      `✅ <b>Đặt hàng thành công!</b>\n\n` +
      `📦 Sản phẩm: <b>${product.name}</b>\n` +
      `💰 Đã thanh toán: <b>${formatVnd(product.price)}</b>\n` +
      `💳 Số dư còn lại: <b>${formatVnd(userAfter?.balance ?? 0)}</b>\n` +
      `🆔 Mã đơn: #${order!.id}`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🏠 Menu chính", "main:back") }
    );
    await ctx.reply(
      `🔑 <b>Thông tin sản phẩm của bạn:</b>\n\n<code>${item.content}</code>\n\n` +
      `💡 Nhấn vào nội dung trên để sao chép nhanh.`,
      { parse_mode: "HTML" }
    );
  });

  // ─── Admin commands ───────────────────────────────────────────────────────

  // /napvi <telegram_id> <so_tien> [ghi_chu]  — Admin nạp tiền thủ công cho user
  b.command("napvi", async (ctx) => {
    if (!ctx.from) return;
    if (!isAdmin(ctx.from.id)) { await ctx.reply("⛔ Bạn không có quyền dùng lệnh này."); return; }

    const parts = (ctx.message?.text ?? "").split(" ").slice(1);
    const targetId = parseInt(parts[0] ?? "");
    const amount = parseInt(parts[1] ?? "");
    const note = parts.slice(2).join(" ") || "Nạp tiền từ admin";

    if (!targetId || !amount || amount <= 0) {
      await ctx.reply("❌ Cú pháp: /napvi <telegram_id> <so_tien> [ghi_chu]\nVD: /napvi 123456789 50000 chuyển khoản MB");
      return;
    }

    const targetUser = await db.query.botUsersTable.findFirst({ where: eq(botUsersTable.telegramId, targetId) });
    if (!targetUser) {
      await ctx.reply(`❌ Không tìm thấy user Telegram ID: ${targetId}\nUser phải dùng /start trước.`);
      return;
    }

    const balanceBefore = targetUser.balance;
    const balanceAfter = balanceBefore + amount;

    await db.update(botUsersTable).set({ balance: balanceAfter }).where(eq(botUsersTable.telegramId, targetId));
    await db.insert(walletTransactionsTable).values({
      telegramUserId: targetId,
      type: "deposit",
      amount,
      balanceBefore,
      balanceAfter,
      note,
      confirmedByAdmin: ctx.from.id,
    });

    const displayName = [targetUser.firstName, targetUser.lastName].filter(Boolean).join(" ") || targetUser.username || `ID ${targetId}`;

    await ctx.reply(
      `✅ <b>Nạp tiền thành công!</b>\n\n` +
      `👤 User: <b>${displayName}</b> (ID: <code>${targetId}</code>)\n` +
      `⬆️ Nạp: <b>${formatVnd(amount)}</b>\n` +
      `💳 Số dư mới: <b>${formatVnd(balanceAfter)}</b>\n` +
      `📝 Ghi chú: ${note}`,
      { parse_mode: "HTML" }
    );

    // Thông báo cho user
    if (bot) {
      try {
        await bot.api.sendMessage(
          targetId,
          `💰 <b>Ví của bạn đã được nạp tiền!</b>\n\n` +
          `⬆️ Số tiền: <b>${formatVnd(amount)}</b>\n` +
          `💳 Số dư mới: <b>${formatVnd(balanceAfter)}</b>\n` +
          `📝 Ghi chú: ${note}`,
          { parse_mode: "HTML" }
        );
      } catch { /* user có thể chặn bot */ }
    }
  });

  // /sodu_user <telegram_id> — Xem số dư của user
  b.command("sodu_user", async (ctx) => {
    if (!ctx.from) return;
    if (!isAdmin(ctx.from.id)) { await ctx.reply("⛔ Bạn không có quyền dùng lệnh này."); return; }
    const parts = (ctx.message?.text ?? "").split(" ");
    const targetId = parseInt(parts[1] ?? "");
    if (!targetId) { await ctx.reply("Cú pháp: /sodu_user <telegram_id>"); return; }
    const user = await db.query.botUsersTable.findFirst({ where: eq(botUsersTable.telegramId, targetId) });
    if (!user) { await ctx.reply("❌ Không tìm thấy user"); return; }
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || `ID ${targetId}`;
    await ctx.reply(`👤 <b>${name}</b>\n🆔 <code>${targetId}</code>\n💳 Số dư: <b>${formatVnd(user.balance)}</b>`, { parse_mode: "HTML" });
  });

  // /orders — lịch sử đơn hàng (command fallback)
  b.command("orders", async (ctx) => {
    if (!ctx.from) return;
    const orders = await db
      .select({ id: ordersTable.id, status: ordersTable.status, totalPrice: ordersTable.totalPrice, productName: ordersTable.productName })
      .from(ordersTable).where(eq(ordersTable.telegramUserId, ctx.from.id)).limit(10);
    if (orders.length === 0) { await ctx.reply("Bạn chưa có đơn hàng nào."); return; }
    const label: Record<string, string> = { pending_payment: "⏳", paid: "✅", delivered: "📦", cancelled: "❌" };
    const text = orders.map((o) => `#${o.id} ${label[o.status] ?? ""} ${formatVnd(o.totalPrice)}${o.productName ? ` — ${o.productName.slice(0, 25)}` : ""}`).join("\n");
    await ctx.reply(`📋 <b>Đơn hàng gần đây:</b>\n\n${text}`, { parse_mode: "HTML" });
  });

  // /sodu — kiểm tra số dư ví (command)
  b.command("sodu", async (ctx) => {
    if (!ctx.from) return;
    await upsertUser(ctx.from);
    const user = await getUser(ctx.from.id);
    await ctx.reply(`💳 Số dư ví của bạn: <b>${formatVnd(user?.balance ?? 0)}</b>`, { parse_mode: "HTML" });
  });

  b.command("thongke", async (ctx) => {
    if (!isTokenConfigured()) { await ctx.reply("⚠️ Chưa cấu hình GCMMO_ACCESS_TOKEN."); return; }
    try {
      const summary = await getDashboardSummary();
      await ctx.reply(
        `📊 <b>Thống kê gcmmo.net</b>\n\n💰 Doanh thu: <b>${formatVnd(summary.total_revenue ?? 0)}</b>\n📦 Tổng đơn: <b>${summary.total_orders ?? 0}</b>\n✅ Hoàn thành: <b>${summary.completed_orders ?? 0}</b>`,
        { parse_mode: "HTML" }
      );
    } catch (err) { await ctx.reply(`❌ Lỗi: ${(err as Error).message}`); }
  });

  b.command("dongbo", async (ctx) => {
    if (!isTokenConfigured()) { await ctx.reply("⚠️ Chưa cấu hình GCMMO_ACCESS_TOKEN."); return; }
    await ctx.reply("🔄 Đang đồng bộ...");
    try {
      const result = await fullSync();
      await ctx.reply(`✅ <b>Đồng bộ hoàn tất!</b>\n\n📦 ${result.products.message}\n🛒 ${result.orders.message}`, { parse_mode: "HTML" });
    } catch (err) { await ctx.reply(`❌ Lỗi: ${(err as Error).message}`); }
  });

  b.command("gcmmo_status", async (ctx) => {
    const configured = isTokenConfigured();
    const lastSync = lastSyncTime ? lastSyncTime.toLocaleString("vi-VN") : "Chưa đồng bộ";
    if (!configured) { await ctx.reply("⚠️ Chưa kết nối gcmmo.net"); return; }
    const pOk = lastSyncResult?.products.ok ? "✅" : "❌";
    const oOk = lastSyncResult?.orders.ok ? "✅" : "❌";
    await ctx.reply(
      `🔗 <b>Trạng thái gcmmo.net</b>\n\n🔑 Token: ✅\n⏰ Sync gần nhất: ${lastSync}\n${pOk} ${lastSyncResult?.products.message ?? "—"}\n${oOk} ${lastSyncResult?.orders.message ?? "—"}`,
      { parse_mode: "HTML" }
    );
  });

  b.command("connect", async (ctx) => {
    if (!ctx.from) return;
    if (!isAdmin(ctx.from.id)) { await ctx.reply("⛔ Bạn không có quyền dùng lệnh này."); return; }
    connectStates.set(ctx.from.id, { step: "waiting_phone" });
    await ctx.reply("📱 <b>Kết nối gcmmo.net</b>\n\nNhập số điện thoại Telegram (0988... hoặc +84...):", { parse_mode: "HTML" });
  });

  b.command("help", (ctx) =>
    ctx.reply(
      "🤖 <b>GC MMO Shop</b>\n\n" +
      "/start — Menu chính\n/sodu — Số dư ví\n/orders — Lịch sử mua hàng\n\n" +
      "<b>Admin:</b>\n/napvi &lt;id&gt; &lt;số_tiền&gt; [ghi_chú] — Nạp tiền cho user\n/sodu_user &lt;id&gt; — Xem số dư user\n/connect — Kết nối gcmmo\n/dongbo /thongke /gcmmo_status",
      { parse_mode: "HTML" }
    )
  );

  // ─── Text handler (topup amount + connect flow + default) ─────────────────
  b.on("message:text", async (ctx) => {
    if (!ctx.from) return;
    await upsertUser(ctx.from);

    // ── Topup: user nhập số tiền tùy ý ──────────────────────────────────────
    const topupState = topupInputStates.get(ctx.from.id);
    if (topupState?.step === "waiting_amount") {
      topupInputStates.delete(ctx.from.id);
      const raw = ctx.message.text.trim().replace(/[.,\s_]/g, "");
      const amount = parseInt(raw);

      if (isNaN(amount) || amount <= 0) {
        const kb = new InlineKeyboard().text("🔄 Thử lại", "topup:custom").row().text("🔙 Quay lại", "main:topup");
        await ctx.reply("❌ Số tiền không hợp lệ. Nhập lại số nguyên (VD: <code>75000</code>)", { parse_mode: "HTML", reply_markup: kb });
        return;
      }

      const sent = await ctx.reply(`⏳ Đang tạo phiên nạp <b>${formatVnd(amount)}</b>...`, { parse_mode: "HTML" });
      await doCreateDeposit(ctx.from.id, ctx.chat.id, amount, b, async (text, kb) => {
        await b.api.editMessageText(ctx.chat.id, sent.message_id, text, { parse_mode: "HTML", reply_markup: kb });
      });
      return;
    }

    const state = connectStates.get(ctx.from.id);
    if (state) {
      if (state.step === "waiting_phone") {
        const phone = ctx.message.text.trim();
        await ctx.reply("⏳ Đang gửi yêu cầu tới Telegram...");
        const result = await tgAuthStart(phone);
        if (!result.ok) { connectStates.delete(ctx.from.id); await ctx.reply(`❌ Lỗi: ${result.error}`); return; }
        connectStates.set(ctx.from.id, { step: "polling", session: result.session });
        const sent = await ctx.reply(
          "✅ Đã gửi!\n\n📲 Mở app Telegram → nhấn <b>Allow</b> cho gcmmo.net\n\n⏳ Đang chờ (tối đa 3 phút)...",
          { parse_mode: "HTML" }
        );
        const userId = ctx.from.id;
        const chatId = ctx.chat.id;
        const deadline = Date.now() + 180_000;
        const poll = async () => {
          const cur = connectStates.get(userId);
          if (!cur || cur.step !== "polling" || !cur.session) return;
          const pollResult = await tgAuthPoll(cur.session);
          if (pollResult.status === "waiting") {
            connectStates.set(userId, { ...cur, session: pollResult.session });
            if (Date.now() < deadline) setTimeout(poll, 3000);
            else { connectStates.delete(userId); await b.api.sendMessage(chatId, "⏰ Hết thời gian. Gõ /connect để thử lại."); }
            return;
          }
          if (pollResult.status === "expired") { connectStates.delete(userId); await b.api.sendMessage(chatId, "❌ Phiên hết hạn. Gõ /connect để thử lại."); return; }
          connectStates.delete(userId);
          await b.api.sendMessage(chatId, `✅ Xác nhận thành công! Xin chào <b>${pollResult.user.first_name}</b>!\n\n🔄 Đang lấy token gcmmo...`, { parse_mode: "HTML" });
          const loginResult = await gcmmoLogin(pollResult.user);
          if (!loginResult.ok) { await b.api.sendMessage(chatId, `❌ Lấy token thất bại: ${loginResult.error}`); return; }
          if (loginResult.access_token) {
            await b.api.sendMessage(chatId, "🔑 Đã lưu token!\n\n🔄 Đang đồng bộ sản phẩm...");
            try {
              startAutoSync();
              const syncResult = await fullSync();
              await b.api.sendMessage(chatId, `✅ <b>Hoàn tất!</b>\n\n📦 ${syncResult.products.message}\n🛒 ${syncResult.orders.message}\n\nBot sẵn sàng bán hàng!`, { parse_mode: "HTML" });
            } catch (err) { await b.api.sendMessage(chatId, `⚠️ Token OK nhưng sync lỗi: ${(err as Error).message}`); }
          } else {
            await b.api.sendMessage(chatId, "⚠️ Đăng nhập thành công nhưng không lấy được token.\nVào Admin → Kết nối gcmmo → Thủ công.");
          }
        };
        setTimeout(poll, 3000);
        return;
      }
      return;
    }

    // Default reply
    await ctx.reply(
      "Dùng /start để mở menu hoặc chọn bên dưới:",
      { parse_mode: "HTML", reply_markup: buildMainMenu() }
    );
  });

  b.catch((err) => logger.error({ err }, "Bot error"));
}
