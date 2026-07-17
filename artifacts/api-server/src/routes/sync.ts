import { Router } from "express";
import { isTokenConfigured, getSellerBalance, getDashboardSummary, getSellerProfile } from "../lib/gcmmo-api.js";
import {
  fullSync,
  syncProducts,
  syncOrders,
  syncInventory,
  lastSyncResult,
  lastSyncTime,
} from "../lib/gcmmo-sync.js";

const router = Router();

// GET /api/sync/status — trạng thái đồng bộ và thông tin gcmmo
router.get("/sync/status", async (req, res) => {
  const configured = isTokenConfigured();
  if (!configured) {
    return res.json({
      configured: false,
      message: "GCMMO_ACCESS_TOKEN chưa được cấu hình",
      lastSync: null,
      lastResult: null,
    });
  }

  try {
    const [balance, summary, profile] = await Promise.allSettled([
      getSellerBalance(),
      getDashboardSummary(),
      getSellerProfile(),
    ]);

    return res.json({
      configured: true,
      lastSync: lastSyncTime?.toISOString() ?? null,
      lastResult: lastSyncResult,
      balance: balance.status === "fulfilled" ? balance.value : null,
      summary: summary.status === "fulfilled" ? summary.value : null,
      profile: profile.status === "fulfilled" ? profile.value : null,
      balanceError: balance.status === "rejected" ? (balance.reason as Error).message : null,
    });
  } catch (err) {
    return res.status(500).json({ configured: true, error: (err as Error).message });
  }
});

// POST /api/sync — đồng bộ toàn bộ
router.post("/sync", async (req, res) => {
  if (!isTokenConfigured()) {
    return res.status(400).json({ ok: false, message: "GCMMO_ACCESS_TOKEN chưa được cấu hình" });
  }
  try {
    const result = await fullSync();
    return res.json(result);
  } catch (err) {
    req.log.error({ err }, "Full sync failed");
    return res.status(500).json({ ok: false, message: (err as Error).message });
  }
});

// POST /api/sync/products
router.post("/sync/products", async (req, res) => {
  if (!isTokenConfigured()) return res.status(400).json({ ok: false, message: "Token chưa cấu hình" });
  try {
    const result = await syncProducts();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, message: (err as Error).message });
  }
});

// POST /api/sync/orders
router.post("/sync/orders", async (req, res) => {
  if (!isTokenConfigured()) return res.status(400).json({ ok: false, message: "Token chưa cấu hình" });
  try {
    const result = await syncOrders();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, message: (err as Error).message });
  }
});

// POST /api/sync/inventory
router.post("/sync/inventory", async (req, res) => {
  if (!isTokenConfigured()) return res.status(400).json({ ok: false, message: "Token chưa cấu hình" });
  try {
    const result = await syncInventory();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, message: (err as Error).message });
  }
});

// GET /api/sync/balance
router.get("/sync/balance", async (req, res) => {
  if (!isTokenConfigured()) return res.status(400).json({ error: "Token chưa cấu hình" });
  try {
    const balance = await getSellerBalance();
    return res.json(balance);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
