import { pgTable, serial, text, integer, bigint, timestamp } from "drizzle-orm/pg-core";

/**
 * Lưu các phiên nạp tiền đang chờ xác nhận từ gcmmo.
 * Dùng để resume poll sau khi server restart — không mất deposit nữa.
 *
 * status:
 *  "polling"   — đang chờ gcmmo xác nhận
 *  "completed" — gcmmo xác nhận, đã cộng ví
 *  "expired"   — hết hạn, chưa nhận được tiền
 *  "cancelled" — huỷ
 */
export const pendingDepositsTable = pgTable("pending_deposits", {
  id: serial("id").primaryKey(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  gcmmoDepositId: text("gcmmo_deposit_id").notNull().unique(),
  amount: integer("amount").notNull(),                  // VND
  transferContent: text("transfer_content").notNull(),  // Nội dung CK (để hiển thị khi hết hạn)
  status: text("status").notNull().default("polling"),  // polling | completed | expired | cancelled
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

export type PendingDeposit = typeof pendingDepositsTable.$inferSelect;
