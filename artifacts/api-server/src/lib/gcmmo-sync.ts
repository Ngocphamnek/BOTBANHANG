/**
 * Đồng bộ dữ liệu giữa gcmmo.net và database local
 */

import { eq } from "drizzle-orm";
import { db, productsTable, ordersTable, inventoryItemsTable } from "@workspace/db";
import {
  getMarketplaceProducts,
  getSellerProducts,
  getSellerOrders,
  getSellerBalance,
  type GcmmoProduct,
  type GcmmoOrder,
} from "./gcmmo-api.js";
import { settingsTable } from "@workspace/db";
import { logger } from "./logger.js";

export interface SyncResult {
  ok: boolean;
  synced: number;
  updated: number;
  message: string;
  error?: string;
}

export interface FullSyncResult {
  products: SyncResult;
  orders: SyncResult;
  inventory: SyncResult;
  balance?: { available: number; pending: number; currency: string };
  timestamp: string;
}

// ─── Tự động phân loại sản phẩm theo tên ────────────────────────────────────
const CATEGORY_RULES: Array<{ pattern: RegExp; label: string }> = [
  // AI / Trí tuệ nhân tạo
  { pattern: /chatgpt|gpt|openai|claude|gemini|grok|deepseek|copilot|midjourney|dall[-\s]?e|elevenlabs|kling|sora|recraft|veo|runway|imagen|ai image|ai video|ai voice|ai art|artificial/i, label: "🤖 AI" },
  // Streaming / Giải trí
  { pattern: /netflix|youtube premium|spotify|disney\+|hbo|apple tv|amazon prime|crunchyroll|capcut|canva|adobe|figma|notion|loom/i, label: "🎬 Streaming" },
  // Telegram / Discord
  { pattern: /telegram premium|telegram prem|discord nitro|discord boost/i, label: "💬 Telegram & Discord" },
  // Social Media / Tăng tương tác
  { pattern: /tik tok|tiktok|facebook|instagram|twitter|x\.com|youtube sub|follow|like|view|subscriber|tương tác|smm|reels/i, label: "📱 Social Media" },
  // VPN / Proxy / Mạng
  { pattern: /vpn|proxy|socks5|ipv4|ipv6|ssh|rdp|vps|hosting|domain|server|bandwidth|tunnel/i, label: "🌐 Proxy & VPN" },
  // Windows / Office / Microsoft
  { pattern: /windows|office 365|microsoft office|ms office|office pro|key win|key office|word|excel|powerpoint/i, label: "🖥️ Windows & Office" },
  // Tool / Phần mềm
  { pattern: /tool|phần mềm|software|script|bot|auto|macro|extension|plugin|crack|key\s|license|keygen|gpm|anti.detect|multi.thread|browser|treo live|livestream/i, label: "🔧 Tool & Phần mềm" },
  // Game
  { pattern: /game|gta|pubg|liên quân|steam|valorant|lol|minecraft|roblox|free fire|ninja|rank|bảng xếp|random acc game|skin|vàng|xu game/i, label: "🎮 Game" },
  // Khóa học / Tài liệu
  { pattern: /khóa học|khoá học|học lập trình|course|tutorial|ebook|tài liệu|đồ án|datn|mã nguồn|source code|font|template|motion graphic|file project/i, label: "📚 Khóa học & Tài liệu" },
  // Dịch vụ / Hỗ trợ
  { pattern: /dịch vụ|hỗ trợ|unlock|mở khóa|giải pháp|restore|recover|unban|repair|nâng cấp|đặt hộ|order|booking|voucher|coupon|mã giảm/i, label: "🛎️ Dịch vụ" },
];

export function categorizeProduct(name: string): string {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(name)) return rule.label;
  }
  return "📦 Khác";
}

/**
 * Tính giá bán với markup 1-5% tùy theo giá gốc và danh mục.
 * Giá cao → margin thấp; Giá thấp → margin cao.
 * Làm tròn lên bội số của 1000 hoặc 100 cho đẹp.
 */
export function calculateMarkupPrice(gcmmoPrice: number, category: string): number {
  if (gcmmoPrice <= 0) return gcmmoPrice;

  let pct: number;
  if (gcmmoPrice < 5_000)        pct = 0.05; // 5%
  else if (gcmmoPrice < 20_000)  pct = 0.04; // 4%
  else if (gcmmoPrice < 50_000)  pct = 0.03; // 3%
  else if (gcmmoPrice < 200_000) pct = 0.02; // 2%
  else                            pct = 0.01; // 1%

  const raw = gcmmoPrice * (1 + pct);
  // Làm tròn lên bội số 1000 nếu >= 10k, 100 nếu nhỏ hơn
  const unit = gcmmoPrice >= 10_000 ? 1000 : 100;
  return Math.ceil(raw / unit) * unit;
}

// ─── Sync products ────────────────────────────────────────────────────────────

export async function syncProducts(): Promise<SyncResult> {
  try {
    // Đọc filter seller_slugs từ settings (comma-separated)
    let sellerSlugs: string[] = [];
    try {
      const rows = await db.select().from(settingsTable)
        .where(eq(settingsTable.key, "syncSellerSlugs"));
      const raw = rows[0]?.value ?? "";
      sellerSlugs = raw.split(",").map(s => s.trim()).filter(Boolean);
    } catch { /* ignore, sync all */ }

    // Lấy từ marketplace (tất cả shop hoặc lọc theo seller_slug)
    const { products, total } = await getMarketplaceProducts({ sellerSlugs, maxProducts: 500 });
    logger.info({ total, fetched: products.length, sellerSlugs }, "Fetched gcmmo marketplace products");

    let synced = 0;
    let updated = 0;

    for (const p of products) {
      const existing = await db.query.productsTable.findFirst({
        where: eq(productsTable.sourceId, p.id),
      });

      const gcmmoPrice = Math.round(p.price);
      const imageUrl = p.image_url ?? p.images?.[0] ?? "";
      const category = categorizeProduct(p.name);   // phân loại theo tên
      const sellingPrice = calculateMarkupPrice(gcmmoPrice, category); // markup 1-5%

      // Lấy variantId và sellerId từ gcmmo product data
      const extProduct = p as GcmmoProduct & { seller_id?: string; variants?: any[] };
      const firstVariant = extProduct.variants?.[0];
      const gcmmoVariantId: string | null = firstVariant?.id ?? null;
      const gcmmoSellerId: string | null = extProduct.seller_id ?? null;

      if (existing) {
        await db
          .update(productsTable)
          .set({
            name: p.name,
            category,                        // cập nhật lại category khi sync
            gcmmoPrice,
            imageUrl,
            description: p.description || null,
            isActive: p.status === "active",
            stock: p.stock,
            gcmmoVariantId,
            gcmmoSellerId,
            updatedAt: new Date(),
            // Chỉ cập nhật price nếu admin chưa đặt markup riêng
            // (price == gcmmoPrice → vẫn dùng default → áp markup mới)
            ...(existing.price === existing.gcmmoPrice ? { price: sellingPrice } : {}),
          })
          .where(eq(productsTable.id, existing.id));
        updated++;
      } else {
        await db.insert(productsTable).values({
          name: p.name,
          price: sellingPrice,   // markup 1-5% ngay khi import
          gcmmoPrice,
          category,
          sourceId: p.id,
          gcmmoVariantId,
          gcmmoSellerId,
          imageUrl,
          description: p.description || null,
          isActive: p.status === "active",
          stock: p.stock,
        });
        synced++;
      }
    }

    return {
      ok: true,
      synced,
      updated,
      message: `${synced} sản phẩm mới, ${updated} đã cập nhật (tổng ${total} trên gcmmo)`,
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err }, "syncProducts failed");
    return { ok: false, synced: 0, updated: 0, message: "Lỗi đồng bộ sản phẩm", error: msg };
  }
}

// ─── Sync orders ──────────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, string> = {
  pending: "pending_payment",
  paid: "paid",
  completed: "delivered",
  cancelled: "cancelled",
  disputed: "cancelled",
};

export async function syncOrders(): Promise<SyncResult> {
  try {
    const { orders, total } = await getSellerOrders({ limit: 100 });
    logger.info({ total }, "Fetched gcmmo seller orders");

    let synced = 0;
    let updated = 0;

    for (const o of orders) {
      const product = await db.query.productsTable.findFirst({
        where: eq(productsTable.sourceId, o.product_id),
      });

      const existing = await db.query.ordersTable.findFirst({
        where: eq(ordersTable.gcmmoOrderId, o.id),
      });

      const localStatus = STATUS_MAP[o.status] ?? "pending_payment";
      const totalPrice = Math.round(o.total_price);

      if (existing) {
        await db
          .update(ordersTable)
          .set({ status: localStatus as any, updatedAt: new Date() })
          .where(eq(ordersTable.id, existing.id));
        updated++;
      } else {
        await db.insert(ordersTable).values({
          gcmmoOrderId: o.id,
          telegramUserId: 0,
          telegramUsername: o.buyer_telegram ?? null,
          productId: product?.id ?? null,
          productName: o.product_name,
          quantity: o.quantity,
          totalPrice,
          status: localStatus as any,
          source: "gcmmo",
        });
        synced++;
      }
    }

    return {
      ok: true,
      synced,
      updated,
      message: `${synced} đơn hàng mới, ${updated} đã cập nhật (tổng ${total} trên gcmmo)`,
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err }, "syncOrders failed");
    return { ok: false, synced: 0, updated: 0, message: "Lỗi đồng bộ đơn hàng", error: msg };
  }
}

// ─── Sync inventory ───────────────────────────────────────────────────────────

export async function syncInventory(): Promise<SyncResult> {
  // Inventory items are managed manually via admin panel / bot
  // gcmmo.net does not expose individual inventory items via API
  return { ok: true, synced: 0, updated: 0, message: "Kho hàng quản lý nội bộ — không cần đồng bộ từ gcmmo" };
}

// ─── Full sync ────────────────────────────────────────────────────────────────

export async function fullSync(): Promise<FullSyncResult> {
  const [products, orders, inventory, balanceResult] = await Promise.allSettled([
    syncProducts(),
    syncOrders(),
    syncInventory(),
    getSellerBalance(),
  ]);

  const result: FullSyncResult = {
    products: products.status === "fulfilled" ? products.value : { ok: false, synced: 0, updated: 0, message: "Lỗi", error: (products.reason as Error).message },
    orders: orders.status === "fulfilled" ? orders.value : { ok: false, synced: 0, updated: 0, message: "Lỗi", error: (orders.reason as Error).message },
    inventory: inventory.status === "fulfilled" ? inventory.value : { ok: false, synced: 0, updated: 0, message: "Lỗi", error: (inventory.reason as Error).message },
    balance: balanceResult.status === "fulfilled" ? balanceResult.value : undefined,
    timestamp: new Date().toISOString(),
  };

  logger.info(result, "Full sync complete");
  return result;
}

// ─── Auto-sync scheduler ──────────────────────────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null;
export let lastSyncResult: FullSyncResult | null = null;
export let lastSyncTime: Date | null = null;

export function startAutoSync(intervalMs = 30 * 60 * 1000) {
  if (syncTimer) return;
  logger.info({ intervalMs }, "Starting gcmmo auto-sync scheduler");

  // Run immediately on start
  fullSync().then((r) => {
    lastSyncResult = r;
    lastSyncTime = new Date();
  });

  syncTimer = setInterval(async () => {
    try {
      lastSyncResult = await fullSync();
      lastSyncTime = new Date();
    } catch (err) {
      logger.error({ err }, "Auto-sync failed");
    }
  }, intervalMs);
}

export function stopAutoSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
