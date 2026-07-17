/**
 * Client cho REST API của gcmmo.net
 * Base URL: https://api.gcmmo.net
 * Auth: Bearer token (lấy từ cookies/localStorage sau khi đăng nhập)
 */

import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const BASE_URL = "https://api.gcmmo.net";

// In-memory token cache (refreshed automatically)
let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;
// Track whether we've attempted to load from DB on startup
let dbTokenLoaded = false;

function parseJwtExp(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64").toString());
    return (payload.exp ?? 0) * 1000; // convert to ms
  } catch {
    return 0;
  }
}

/**
 * Lưu token vào in-memory VÀ DB settings để tồn tại qua restart.
 * Gọi tại mọi nơi nhận được token mới (OAuth, relay, manual).
 */
export async function setGcmmoTokens(accessToken: string, refreshToken?: string): Promise<void> {
  // Set in-memory
  process.env["GCMMO_ACCESS_TOKEN"] = accessToken;
  cachedToken = accessToken;
  tokenExpiresAt = parseJwtExp(accessToken) - 60_000;
  dbTokenLoaded = true;

  if (refreshToken) {
    process.env["GCMMO_REFRESH_TOKEN"] = refreshToken;
  }

  // Persist to DB (fire & forget, don't block callers)
  try {
    await db.insert(settingsTable).values({ key: "gcmmoAccessToken", value: accessToken, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: accessToken, updatedAt: new Date() } });
    if (refreshToken) {
      await db.insert(settingsTable).values({ key: "gcmmoRefreshToken", value: refreshToken, updatedAt: new Date() })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value: refreshToken, updatedAt: new Date() } });
    }
  } catch (e) {
    console.error("setGcmmoTokens: DB save failed", e);
  }

  // Tự động bật đồng bộ ngay khi có token — dù token đến từ nguồn nào
  // (bot /connect, relay, admin settings, tg-oauth)
  try {
    const { startAutoSync } = await import("./gcmmo-sync.js");
    startAutoSync(30 * 60 * 1000);
  } catch (e) {
    console.error("setGcmmoTokens: startAutoSync failed", e);
  }
}

/** Load token từ DB nếu env không có (chạy một lần khi startup) */
export async function loadGcmmoTokensFromDb(): Promise<boolean> {
  if (dbTokenLoaded) return !!cachedToken;
  dbTokenLoaded = true;
  try {
    const rows = await db.select().from(settingsTable)
      .where(eq(settingsTable.key, "gcmmoAccessToken"));
    const accessToken = rows[0]?.value;
    if (accessToken) {
      process.env["GCMMO_ACCESS_TOKEN"] = accessToken;
      cachedToken = accessToken;
      tokenExpiresAt = parseJwtExp(accessToken) - 60_000;

      const rrows = await db.select().from(settingsTable)
        .where(eq(settingsTable.key, "gcmmoRefreshToken"));
      const refreshToken = rrows[0]?.value;
      if (refreshToken) process.env["GCMMO_REFRESH_TOKEN"] = refreshToken;
      return true;
    }
  } catch (e) {
    console.error("loadGcmmoTokensFromDb failed", e);
  }
  return false;
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = process.env.GCMMO_REFRESH_TOKEN;
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${BASE_URL}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const newToken: string | undefined = data?.access_token ?? data?.accessToken ?? data?.token;
    if (newToken) {
      cachedToken = newToken;
      tokenExpiresAt = parseJwtExp(newToken) - 60_000;
      // Persist refreshed token
      setGcmmoTokens(newToken).catch(() => {});
      return newToken;
    }
  } catch {}
  return null;
}

async function getToken(): Promise<string> {
  // Use cached token if still valid
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  // Try refreshing via refresh token
  const refreshed = await refreshAccessToken();
  if (refreshed) return refreshed;

  // Fall back to env token (set via Secrets or startup DB load)
  const envToken = process.env.GCMMO_ACCESS_TOKEN;
  if (envToken) {
    cachedToken = envToken;
    tokenExpiresAt = parseJwtExp(envToken) - 60_000;
    return envToken;
  }

  // Last attempt: load from DB
  const loaded = await loadGcmmoTokensFromDb();
  if (loaded && cachedToken) return cachedToken;

  throw new Error("GCMMO_ACCESS_TOKEN chưa được cấu hình. Vào Cài đặt để thêm token.");
}

async function gcmmoFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await res.text();
  // If 401, try once with a forced refresh
  if (res.status === 401) {
    cachedToken = null;
    tokenExpiresAt = 0;
    const newToken = await refreshAccessToken();
    if (newToken) {
      const retry = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${newToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
      const retryText = await retry.text();
      if (!retry.ok) throw new Error(`gcmmo API ${retry.status} ${path}: ${retryText.slice(0, 200)}`);
      try { return JSON.parse(retryText) as T; } catch { throw new Error(`gcmmo parse error ${path}`); }
    }
    throw new Error(`gcmmo API 401 ${path} — token hết hạn và không thể làm mới`);
  }
  if (!res.ok) {
    throw new Error(`gcmmo API ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`gcmmo API parse error ${path}: ${text.slice(0, 100)}`);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GcmmoProduct {
  id: string;
  name: string;
  slug: string;
  description: string;
  price: number;           // in VND
  original_price?: number;
  category_id: string;
  category?: { name: string; slug: string };
  status: "active" | "inactive" | "draft";
  stock: number;
  sold_count: number;
  image_url?: string;
  images?: string[];
  created_at: string;
  updated_at: string;
}

export interface GcmmoOrder {
  id: string;
  buyer_id?: string;
  buyer_telegram?: string;
  product_id: string;
  product_name: string;
  quantity: number;
  total_price: number;
  status: "pending" | "paid" | "completed" | "cancelled" | "disputed";
  created_at: string;
  updated_at: string;
}

export interface GcmmoBalance {
  available: number;
  pending: number;
  currency: string;
}

export interface GcmmoDashboardSummary {
  total_revenue: number;
  total_orders: number;
  completed_orders: number;
  pending_orders: number;
  cancelled_orders: number;
  total_products?: number;
}

export interface GcmmoSellerProfile {
  id: string;
  name?: string;
  shop_name?: string;
  email?: string;
  telegram?: string;
}

export interface GcmmoSeller {
  id: string;
  slug: string;
  name: string;
  rating: number;        // 0–5 sao trung bình
  review_count: number;  // tổng lượt đánh giá
  positive_count: number;
  negative_count: number;
  positive_rate: number; // 0–100 %
  total_sold: number;    // tổng đã bán
  product_count: number; // số sản phẩm đang bán
  avatar_url?: string;
  created_at?: string;
  // Aggregated from products
  min_price: number;
  max_price: number;
  categories: string[];
}

// ─── Marketplace & Seller API ─────────────────────────────────────────────────

const STORAGE_BASE = "https://api.gcmmo.net/storage/public";

function normalizeMarketplaceProduct(p: any): GcmmoProduct {
  // Image: lấy từ media[0].object_key hoặc image_url trực tiếp
  const firstMedia = p.media?.[0];
  const imageUrl = p.image_url
    ?? (firstMedia?.object_key ? `${STORAGE_BASE}/${firstMedia.object_key}` : "");

  // Price: marketplace dùng price_amount (đơn vị VND), seller dùng price
  const price = p.price_amount ?? p.price ?? 0;

  // Name: marketplace dùng title, seller dùng name
  const name = p.title ?? p.name ?? "(Không tên)";

  // Stock: ưu tiên variants[0].stock_count, rồi stock_count, rồi stock
  const firstVariant = p.variants?.[0];
  const stock = firstVariant?.stock_count ?? p.stock_count ?? p.stock ?? 0;
  const stockUnlimited = firstVariant?.stock_unlimited ?? p.stock_unlimited ?? false;

  return {
    id: p.id,
    name,
    slug: p.slug ?? "",
    description: p.description ?? "",
    price,
    category_id: p.category_id ?? "",
    category: p.category,
    status: (p.status === "active" && (stockUnlimited || stock > 0)) ? "active" : (p.status ?? "inactive"),
    stock: stockUnlimited ? 9999 : stock,
    sold_count: p.sold_count ?? 0,
    image_url: imageUrl,
    images: p.media?.map((m: any) => m.object_key ? `${STORAGE_BASE}/${m.object_key}` : "").filter(Boolean),
    created_at: p.created_at ?? "",
    updated_at: p.updated_at ?? "",
    // Extra marketplace fields
    seller_id: p.seller_id ?? p.seller?.id,
    seller_slug: p.seller_slug ?? p.seller?.slug,
    seller_name: p.seller_name ?? p.seller?.name ?? p.seller?.shop_name,
    seller_rating: p.seller?.rating ?? p.seller?.rating_score ?? p.seller_rating,
    seller_review_count: p.seller?.review_count ?? p.seller?.total_reviews ?? p.seller_review_count,
    seller_positive_rate: p.seller?.positive_rate ?? p.seller?.positive_rate_percent ?? p.seller_positive_rate,
    seller_avatar: p.seller?.avatar_url ?? p.seller?.avatar,
    variants: p.variants,
  } as GcmmoProduct & {
    seller_id?: string; seller_slug?: string; seller_name?: string;
    seller_rating?: number; seller_review_count?: number;
    seller_positive_rate?: number; seller_avatar?: string;
    variants?: any[];
  };
}

/**
 * Lấy sản phẩm từ MARKETPLACE gcmmo — tất cả các shop (hoặc lọc theo seller_slug).
 * Tự động phân trang để lấy hết.
 */
export async function getMarketplaceProducts(params?: {
  pageSize?: number;
  sellerSlugs?: string[];
  maxProducts?: number;
}): Promise<{ products: GcmmoProduct[]; total: number }> {
  const pageSize = params?.pageSize ?? 100;
  const maxProducts = params?.maxProducts ?? 2000;
  const slugs = params?.sellerSlugs ?? [];

  const allProducts: GcmmoProduct[] = [];
  let grandTotal = 0;

  // Nếu có filter theo seller, fetch từng seller riêng; không thì fetch tất cả
  const queries = slugs.length > 0 ? slugs : [null];

  for (const sellerSlug of queries) {
    let page = 1;
    let fetchedAll = false;

    while (!fetchedAll && allProducts.length < maxProducts) {
      const q = new URLSearchParams();
      q.set("page_size", String(pageSize));
      q.set("page", String(page));
      if (sellerSlug) q.set("seller_slug", sellerSlug);

      const data = await gcmmoFetch<any>(`/v1/products?${q}`);
      const raw: any[] = Array.isArray(data) ? data : (data?.products ?? data?.data ?? []);
      const total: number = data?.total ?? raw.length;

      if (page === 1) grandTotal += total;

      const normalized = raw.map(normalizeMarketplaceProduct);
      allProducts.push(...normalized);

      if (raw.length < pageSize || allProducts.length >= total) {
        fetchedAll = true;
      } else {
        page++;
      }
    }
  }

  return { products: allProducts, total: grandTotal };
}

/**
 * Lấy thông tin MỘT sản phẩm cụ thể từ gcmmo marketplace (live, không qua cache).
 * Trả về stock thực tế từ web gcmmo.
 */
export async function getGcmmoProductLive(gcmmoProductId: string): Promise<GcmmoProduct> {
  try {
    const data = await gcmmoFetch<any>(`/v1/products/${gcmmoProductId}`);
    return normalizeMarketplaceProduct(data);
  } catch {
    // Fallback: tìm trong danh sách marketplace nếu endpoint đơn không có
    const { products } = await getMarketplaceProducts({ maxProducts: 2000 });
    const found = products.find((p) => p.id === gcmmoProductId);
    if (!found) throw new Error(`Không tìm thấy sản phẩm gcmmo: ${gcmmoProductId}`);
    return found;
  }
}

/** Lấy sản phẩm của chính seller account đang đăng nhập */
export async function getSellerProducts(params?: { limit?: number; offset?: number }): Promise<{ products: GcmmoProduct[]; total: number }> {
  const q = new URLSearchParams();
  q.set("limit", String(params?.limit ?? 100));
  if (params?.offset) q.set("offset", String(params.offset));
  const data = await gcmmoFetch<any>(`/v1/seller/products?${q}`);
  const raw: any[] = Array.isArray(data) ? data : (data?.products ?? data?.data ?? data?.items ?? []);
  const total: number = data?.total ?? data?.count ?? raw.length;
  return { products: raw.map(normalizeMarketplaceProduct), total };
}

export async function getSellerOrders(params?: { limit?: number; offset?: number }): Promise<{ orders: GcmmoOrder[]; total: number }> {
  const q = new URLSearchParams();
  q.set("limit", String(params?.limit ?? 100));
  if (params?.offset) q.set("offset", String(params.offset));
  const data = await gcmmoFetch<any>(`/v1/seller/orders?${q}`);
  const orders: GcmmoOrder[] = Array.isArray(data) ? data : (data?.orders ?? data?.data ?? data?.items ?? []);
  const total: number = data?.total ?? data?.count ?? orders.length;
  return { orders, total };
}

export async function getSellerBalance(): Promise<GcmmoBalance> {
  const data = await gcmmoFetch<any>("/v1/seller/ledger/balances");
  // Normalize different response shapes
  if (Array.isArray(data)) {
    const vnd = data.find((b: any) => b.currency === "VND" || b.currency === "vnd") ?? data[0];
    return {
      available: vnd?.available ?? vnd?.balance ?? 0,
      pending: vnd?.pending ?? 0,
      currency: vnd?.currency ?? "VND",
    };
  }
  return {
    available: data?.available ?? data?.balance ?? 0,
    pending: data?.pending ?? 0,
    currency: data?.currency ?? "VND",
  };
}

export async function getDashboardSummary(): Promise<GcmmoDashboardSummary> {
  const data = await gcmmoFetch<any>("/v1/seller/dashboard/summary");
  const buckets: Array<{ order_count: number; total_amount: number }> = data?.order_summary?.activity_buckets ?? [];
  const total_orders = buckets.reduce((s: number, b: any) => s + (b.order_count ?? 0), 0);
  const total_revenue = buckets.reduce((s: number, b: any) => s + (b.total_amount ?? 0), 0);
  return {
    total_revenue,
    total_orders,
    completed_orders: total_orders,
    pending_orders: data?.order_summary?.manual_fulfillment_count ?? 0,
    cancelled_orders: 0,
    total_products: data?.product_attention ? undefined as any : 0,
  };
}

export async function getSellerProfile(): Promise<GcmmoSellerProfile> {
  return gcmmoFetch("/v1/sellers/me");
}

export function isTokenConfigured(): boolean {
  return !!process.env.GCMMO_ACCESS_TOKEN || !!cachedToken;
}

// ─── Wallet Deposit API ───────────────────────────────────────────────────────

export interface GcmmoDeposit {
  id: string;
  user_id: string;
  currency: string;
  amount: number;
  status: "pending" | "completed" | "expired" | "cancelled";
  payment_code: string;          // mã duy nhất mỗi phiên (VD: GC74H4H1C8R0ZF)
  provider: string;              // "sepay"
  receive_bank_bin: string;      // BIN ngân hàng (VD: "970422" = MB Bank)
  receive_account_number: string;
  receive_account_name: string;
  qr_code_url: string;           // URL ảnh QR VietQR
  transfer_content: string;      // nội dung chuyển khoản (= payment_code)
  expires_at: string;            // ISO timestamp hết hạn
  created_at: string;
  updated_at: string;
}

const BANK_BIN_MAP: Record<string, string> = {
  "970422": "MB Bank",
  "970436": "Vietcombank (VCB)",
  "970415": "Vietinbank",
  "970418": "BIDV",
  "970405": "Agribank",
  "970432": "VPBank",
  "970423": "TPBank",
  "970407": "Techcombank",
  "970443": "SHB",
  "970431": "Eximbank",
  "970441": "VIB",
  "970454": "Tiên Phong Bank",
  "970448": "OCB",
  "970434": "Việt Á Bank",
};

/**
 * Tạo phiên nạp tiền mới trên gcmmo.net.
 * Mỗi phiên có nội dung chuyển khoản duy nhất → không bị nhầm lẫn.
 * Tiền về gcmmo wallet của admin, bot sẽ poll để cộng ví user khi xác nhận.
 */
export async function createGcmmoDeposit(amount: number): Promise<GcmmoDeposit> {
  return gcmmoFetch<GcmmoDeposit>("/v1/wallets/deposits", {
    method: "POST",
    body: JSON.stringify({ amount, currency: "VND" }),
  });
}

/** Lấy trạng thái phiên nạp tiền (dùng để poll xác nhận) */
export async function getGcmmoDeposit(depositId: string): Promise<GcmmoDeposit> {
  return gcmmoFetch<GcmmoDeposit>(`/v1/wallets/deposits/${depositId}`);
}

/** Lấy tên ngân hàng từ BIN code */
export function bankBinToName(bin: string): string {
  return BANK_BIN_MAP[bin] ?? `Bank BIN ${bin}`;
}

// ─── Buyer / Middleman Purchase API ──────────────────────────────────────────

export interface GcmmoBuyerOrder {
  id: string;
  status: string;          // "pending" | "processing" | "completed" | "cancelled"
  product_id: string;
  variant_id?: string;
  quantity: number;
  total_price: number;
  // Different gcmmo response shapes for delivered content:
  delivered_items?: Array<string | { content?: string; account?: string; data?: string }>;
  accounts?: string[];
  content?: string;
  data?: string;
  items?: Array<string | { content?: string }>;
  created_at: string;
  updated_at?: string;
}

/**
 * Mua sản phẩm từ gcmmo marketplace (vai trò buyer).
 * Thứ tự thử endpoint (đã xác nhận tồn tại qua probe):
 *   1. POST /v1/orders/create   ← endpoint chính thức
 *   2. POST /v1/checkout        ← fallback #1
 *   3. POST /v1/cart/checkout   ← fallback #2 (thêm vào cart rồi checkout)
 *   4. POST /v1/orders          ← fallback cuối (chỉ có GET route, POST thường 404)
 *
 * Body thử lần lượt:
 *   - Flat: { product_id, variant_id, quantity }
 *   - Array: { items: [{ product_id, variant_id, quantity }] }
 */
export async function buyGcmmoProduct(params: {
  productId: string;
  variantId?: string;
  quantity?: number;
}): Promise<GcmmoBuyerOrder> {
  const qty = params.quantity ?? 1;

  // Body formats để thử
  const flatBody: Record<string, unknown> = { product_id: params.productId, quantity: qty };
  if (params.variantId) flatBody["variant_id"] = params.variantId;

  const arrayBody: Record<string, unknown> = {
    items: [{ product_id: params.productId, ...(params.variantId ? { variant_id: params.variantId } : {}), quantity: qty }],
  };

  // Endpoint priority (confirmed via probe: orders/create, checkout, cart/checkout exist; buyer/orders does NOT)
  const endpoints: Array<{ path: string; body: Record<string, unknown> }> = [
    { path: "/v1/orders/create", body: flatBody },
    { path: "/v1/orders/create", body: arrayBody },
    { path: "/v1/checkout",      body: flatBody },
    { path: "/v1/checkout",      body: arrayBody },
    { path: "/v1/cart/checkout", body: flatBody },
    { path: "/v1/orders",        body: flatBody },
  ];

  let lastErr: Error = new Error("Không thể đặt hàng từ gcmmo — tất cả endpoint đều thất bại");

  // Idempotency key — unique per purchase attempt, prevents duplicate orders
  const idempotencyKey = `bot-buy-${params.productId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  for (const { path, body } of endpoints) {
    try {
      const result = await gcmmoFetch<GcmmoBuyerOrder>(path, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      });
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      lastErr = err as Error;
      // Chỉ thử tiếp nếu là 404/405 (route không tồn tại hoặc method sai)
      if (msg.includes("404") || msg.includes("405") || msg.includes("Method Not Allowed")) continue;
      // Lỗi khác (401, 422, 500...) → dừng ngay, không thử endpoint khác
      throw err;
    }
  }

  throw lastErr;
}

/**
 * Lấy chi tiết đơn hàng đã mua từ gcmmo.
 * /v1/orders/{id} là endpoint chính (GET /v1/orders tồn tại, xác nhận qua probe).
 * /v1/buyer/orders/{id} KHÔNG tồn tại — đã loại bỏ.
 */
export async function getGcmmoBuyerOrder(orderId: string): Promise<GcmmoBuyerOrder> {
  // Thử các endpoint theo thứ tự ưu tiên
  const paths = [
    `/v1/orders/${orderId}`,
    `/v1/orders/create/${orderId}`,
    `/v1/checkout/${orderId}`,
  ];
  let lastErr: Error = new Error(`Không tìm thấy đơn hàng gcmmo: ${orderId}`);
  for (const path of paths) {
    try {
      return await gcmmoFetch<GcmmoBuyerOrder>(path);
    } catch (err) {
      const msg = (err as Error).message;
      lastErr = err as Error;
      if (msg.includes("404")) continue;
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Trích xuất nội dung hàng đã giao từ response của gcmmo.
 * Xử lý nhiều dạng response khác nhau của gcmmo API.
 */
export function extractDeliveredContent(order: GcmmoBuyerOrder): string[] {
  const items: string[] = [];

  if (order.delivered_items?.length) {
    for (const item of order.delivered_items) {
      if (typeof item === "string" && item.trim()) items.push(item.trim());
      else if (typeof item === "object" && item) {
        const content = item.content ?? item.account ?? item.data ?? "";
        if (content.trim()) items.push(content.trim());
      }
    }
  }
  if (order.items?.length && items.length === 0) {
    for (const item of order.items) {
      if (typeof item === "string" && item.trim()) items.push(item.trim());
      else if (typeof item === "object" && item?.content?.trim()) items.push(item.content.trim());
    }
  }
  if (order.accounts?.length && items.length === 0) {
    items.push(...order.accounts.filter(Boolean));
  }
  if (order.content?.trim() && items.length === 0) {
    items.push(order.content.trim());
  }
  if (order.data?.trim() && items.length === 0) {
    items.push(order.data.trim());
  }

  return items;
}

/**
 * Poll gcmmo order cho đến khi hoàn thành hoặc hết timeout.
 * Returns nội dung đã giao, hoặc null nếu timeout/lỗi.
 */
/**
 * Lấy thông tin chi tiết 1 seller từ gcmmo API (bao gồm rating, review).
 * Thử nhiều endpoint khác nhau vì gcmmo không document rõ.
 */
async function fetchSellerDetail(slug: string): Promise<Partial<GcmmoSeller> | null> {
  // Thử các endpoint phổ biến
  const endpoints = [
    `/v1/sellers/${slug}`,
    `/v1/marketplace/sellers/${slug}`,
    `/v1/shops/${slug}`,
  ];
  for (const ep of endpoints) {
    try {
      const data = await gcmmoFetch<any>(ep);
      if (!data || typeof data !== "object") continue;
      const rating: number =
        data.rating ?? data.rating_score ?? data.average_rating ??
        data.stats?.rating ?? data.shop_rating ?? 0;
      const review_count: number =
        data.review_count ?? data.total_reviews ?? data.reviews_count ??
        data.stats?.review_count ?? data.rating_count ?? 0;
      const positive_count: number =
        data.positive_count ?? data.positive_reviews ??
        data.stats?.positive_count ?? 0;
      const negative_count: number =
        data.negative_count ?? data.negative_reviews ??
        data.stats?.negative_count ?? 0;
      const positive_rate: number =
        data.positive_rate ?? data.positive_rate_percent ??
        (review_count > 0 ? Math.round((positive_count / review_count) * 100) : 0);
      const total_sold: number =
        data.total_sold ?? data.sold_count ?? data.stats?.total_sold ??
        data.orders_completed ?? 0;
      const avatar_url: string | undefined =
        data.avatar_url ?? data.avatar ?? data.shop_avatar ?? data.logo_url;
      const created_at: string | undefined = data.created_at ?? data.joined_at;
      if (rating || review_count || total_sold) {
        return { rating, review_count, positive_count, negative_count, positive_rate, total_sold, avatar_url, created_at };
      }
    } catch {
      // thử endpoint tiếp theo
    }
  }
  return null;
}

/**
 * Lấy danh sách TẤT CẢ sellers trên marketplace, kèm rating/review/stats.
 * Nhóm sản phẩm theo seller, sau đó enrich bằng seller detail API.
 */
export async function getMarketplaceSellers(): Promise<GcmmoSeller[]> {
  const { products } = await getMarketplaceProducts({ maxProducts: 500 });

  // Gom sản phẩm theo seller_id
  const map = new Map<string, {
    id: string; slug: string; name: string;
    products: Array<typeof products[0] & {
      seller_id?: string; seller_slug?: string; seller_name?: string;
      seller_rating?: number; seller_review_count?: number;
      seller_positive_rate?: number; seller_avatar?: string;
    }>;
  }>();

  for (const raw of products) {
    const p = raw as any;
    const sid: string = p.seller_id ?? p.seller_slug ?? "unknown";
    if (!sid || sid === "unknown") continue;
    if (!map.has(sid)) {
      map.set(sid, {
        id: sid,
        slug: p.seller_slug ?? sid,
        name: p.seller_name ?? p.seller_slug ?? sid,
        products: [],
      });
    }
    map.get(sid)!.products.push(p);
  }

  const sellers: GcmmoSeller[] = [];

  for (const [, entry] of map) {
    const prods = entry.products;
    // Lấy rating từ sản phẩm đầu tiên có dữ liệu (nếu API trả về)
    const sampleP = prods.find((p) => p.seller_rating != null) ?? prods[0]!;
    let rating: number = (sampleP as any).seller_rating ?? 0;
    let review_count: number = (sampleP as any).seller_review_count ?? 0;
    let positive_rate: number = (sampleP as any).seller_positive_rate ?? 0;
    let positive_count = 0;
    let negative_count = 0;
    let total_sold: number = prods.reduce((s, p) => s + (p.sold_count ?? 0), 0);
    let avatar_url: string | undefined = (sampleP as any).seller_avatar;
    let created_at: string | undefined;

    // Enrich từ seller detail endpoint (chỉ nếu chưa có rating đủ)
    if (!rating && entry.slug && entry.slug !== "unknown") {
      const detail = await fetchSellerDetail(entry.slug);
      if (detail) {
        rating = detail.rating ?? rating;
        review_count = detail.review_count ?? review_count;
        positive_count = detail.positive_count ?? positive_count;
        negative_count = detail.negative_count ?? negative_count;
        positive_rate = detail.positive_rate ?? positive_rate;
        total_sold = detail.total_sold && detail.total_sold > total_sold ? detail.total_sold : total_sold;
        avatar_url = detail.avatar_url ?? avatar_url;
        created_at = detail.created_at;
      }
    }

    // Tính positive_rate từ counts nếu có
    if (!positive_rate && review_count > 0 && positive_count > 0) {
      positive_rate = Math.round((positive_count / review_count) * 100);
      negative_count = review_count - positive_count;
    }

    const prices = prods.map((p) => p.price).filter((v) => v > 0);
    const categories = [...new Set(prods.map((p) => p.category?.name ?? "").filter(Boolean))];

    sellers.push({
      id: entry.id,
      slug: entry.slug,
      name: entry.name,
      rating,
      review_count,
      positive_count,
      negative_count,
      positive_rate,
      total_sold,
      product_count: prods.length,
      avatar_url,
      created_at,
      min_price: prices.length ? Math.min(...prices) : 0,
      max_price: prices.length ? Math.max(...prices) : 0,
      categories,
    });
  }

  // Sắp xếp: nhiều đánh giá + rating cao lên đầu
  sellers.sort((a, b) => {
    const scoreA = a.rating * 0.5 + Math.log1p(a.review_count) * 0.3 + Math.log1p(a.total_sold) * 0.2;
    const scoreB = b.rating * 0.5 + Math.log1p(b.review_count) * 0.3 + Math.log1p(b.total_sold) * 0.2;
    return scoreB - scoreA;
  });

  return sellers;
}

/**
 * Lấy sản phẩm của một seller cụ thể từ marketplace.
 */
export async function getSellerMarketplaceProducts(sellerSlug: string): Promise<{ products: GcmmoProduct[]; total: number }> {
  return getMarketplaceProducts({ sellerSlugs: [sellerSlug], maxProducts: 200 });
}

export async function pollGcmmoOrderUntilDelivered(
  orderId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ content: string[]; order: GcmmoBuyerOrder } | null> {
  const { timeoutMs = 120_000, intervalMs = 4_000 } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const order = await getGcmmoBuyerOrder(orderId);
      const content = extractDeliveredContent(order);

      if (content.length > 0) return { content, order };
      if (order.status === "cancelled") return null;
      // status "completed" but no content yet — keep polling
    } catch {
      // ignore transient errors, keep polling
    }
  }
  return null;
}
