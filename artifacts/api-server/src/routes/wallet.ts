/**
 * /api/wallet — Quản lý ví người dùng (dành cho admin panel)
 *
 * GET  /wallet/users          — danh sách users + số dư
 * GET  /wallet/transactions   — lịch sử giao dịch toàn bộ
 * POST /wallet/topup          — admin nạp tiền cho user
 */

import { Router } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { db, botUsersTable, walletTransactionsTable } from "@workspace/db";

const router = Router();

// ── GET /wallet/users ─────────────────────────────────────────────────────────
router.get("/wallet/users", async (_req, res) => {
  const users = await db
    .select({
      id: botUsersTable.id,
      telegramId: botUsersTable.telegramId,
      username: botUsersTable.username,
      firstName: botUsersTable.firstName,
      lastName: botUsersTable.lastName,
      balance: botUsersTable.balance,
      createdAt: botUsersTable.createdAt,
    })
    .from(botUsersTable)
    .orderBy(desc(botUsersTable.balance));

  res.json(users);
});

// ── GET /wallet/transactions ──────────────────────────────────────────────────
router.get("/wallet/transactions", async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "50")), 200);
  const offset = parseInt(String(req.query.offset ?? "0"));
  const telegramId = req.query.telegram_id ? parseInt(String(req.query.telegram_id)) : undefined;

  const rows = await db
    .select()
    .from(walletTransactionsTable)
    .where(telegramId ? eq(walletTransactionsTable.telegramUserId, telegramId) : undefined)
    .orderBy(desc(walletTransactionsTable.createdAt))
    .limit(limit)
    .offset(offset);

  const [countRow] = await db
    .select({ total: sql<number>`cast(count(*) as int)` })
    .from(walletTransactionsTable)
    .where(telegramId ? eq(walletTransactionsTable.telegramUserId, telegramId) : undefined);

  res.json({ transactions: rows, total: countRow?.total ?? 0 });
});

// ── POST /wallet/topup ────────────────────────────────────────────────────────
router.post("/wallet/topup", async (req, res) => {
  const { telegramId, amount, note } = req.body as {
    telegramId: number;
    amount: number;
    note?: string;
  };

  if (!telegramId || !amount || amount <= 0) {
    res.status(400).json({ error: "telegramId và amount (> 0) là bắt buộc" });
    return;
  }

  const user = await db.query.botUsersTable.findFirst({
    where: eq(botUsersTable.telegramId, telegramId),
  });

  if (!user) {
    res.status(404).json({ error: `Không tìm thấy user Telegram ID ${telegramId}` });
    return;
  }

  const balanceBefore = user.balance;
  const balanceAfter = balanceBefore + amount;

  await db
    .update(botUsersTable)
    .set({ balance: balanceAfter })
    .where(eq(botUsersTable.telegramId, telegramId));

  await db.insert(walletTransactionsTable).values({
    telegramUserId: telegramId,
    type: "deposit",
    amount,
    balanceBefore,
    balanceAfter,
    note: note ?? "Nạp tiền từ admin panel",
  });

  res.json({
    ok: true,
    telegramId,
    balanceBefore,
    balanceAfter,
    amount,
  });
});

// ── POST /wallet/adjust ───────────────────────────────────────────────────────
// Điều chỉnh số dư (có thể âm để trừ tiền thủ công)
router.post("/wallet/adjust", async (req, res) => {
  const { telegramId, amount, note } = req.body as {
    telegramId: number;
    amount: number;
    note?: string;
  };

  if (!telegramId || amount === undefined || amount === 0) {
    res.status(400).json({ error: "telegramId và amount (khác 0) là bắt buộc" });
    return;
  }

  const user = await db.query.botUsersTable.findFirst({
    where: eq(botUsersTable.telegramId, telegramId),
  });

  if (!user) {
    res.status(404).json({ error: "Không tìm thấy user" });
    return;
  }

  const balanceBefore = user.balance;
  const balanceAfter = Math.max(0, balanceBefore + amount);

  await db
    .update(botUsersTable)
    .set({ balance: balanceAfter })
    .where(eq(botUsersTable.telegramId, telegramId));

  await db.insert(walletTransactionsTable).values({
    telegramUserId: telegramId,
    type: "adjustment",
    amount: balanceAfter - balanceBefore,
    balanceBefore,
    balanceAfter,
    note: note ?? "Điều chỉnh thủ công",
  });

  res.json({ ok: true, telegramId, balanceBefore, balanceAfter });
});

export default router;
