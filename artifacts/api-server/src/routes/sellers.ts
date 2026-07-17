import { Router, type IRouter } from "express";
import { getMarketplaceSellers, getSellerMarketplaceProducts, isTokenConfigured } from "../lib/gcmmo-api.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// Cache để tránh gọi API liên tục (TTL 10 phút)
let sellersCache: { data: any[]; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000;

// GET /sellers — danh sách tất cả sellers trên marketplace, kèm rating/review
router.get("/sellers", async (req, res) => {
  if (!isTokenConfigured()) {
    res.status(400).json({ error: "Chưa kết nối gcmmo.net — vào Cài đặt để thêm token" });
    return;
  }

  const force = req.query.refresh === "1";

  // Trả cache nếu còn hạn
  if (!force && sellersCache && Date.now() - sellersCache.ts < CACHE_TTL) {
    res.json({ sellers: sellersCache.data, cached: true, cachedAt: new Date(sellersCache.ts).toISOString() });
    return;
  }

  try {
    const sellers = await getMarketplaceSellers();
    sellersCache = { data: sellers, ts: Date.now() };
    res.json({ sellers, cached: false, cachedAt: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, "sellers: getMarketplaceSellers failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /sellers/:slug/products — sản phẩm của một seller cụ thể
router.get("/sellers/:slug/products", async (req, res) => {
  if (!isTokenConfigured()) {
    res.status(400).json({ error: "Chưa kết nối gcmmo.net" });
    return;
  }
  try {
    const { products, total } = await getSellerMarketplaceProducts(req.params.slug);
    res.json({ products, total });
  } catch (err) {
    logger.error({ err, slug: req.params.slug }, "sellers: getSellerMarketplaceProducts failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
