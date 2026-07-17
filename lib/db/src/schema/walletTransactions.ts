import { pgTable, serial, text, integer, bigint, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const walletTxTypeEnum = pgEnum("wallet_tx_type", ["deposit", "purchase", "refund", "adjustment"]);

export const walletTransactionsTable = pgTable("wallet_transactions", {
  id: serial("id").primaryKey(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
  type: walletTxTypeEnum("type").notNull(),
  amount: integer("amount").notNull(),           // dương = cộng tiền, âm = trừ tiền (VND)
  balanceBefore: integer("balance_before").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  note: text("note"),                            // Ghi chú (admin nhập khi nạp, mã đơn khi mua)
  orderId: integer("order_id"),                  // liên kết đơn hàng nếu có
  confirmedByAdmin: bigint("confirmed_by_admin", { mode: "number" }), // Telegram ID của admin xác nhận nạp
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertWalletTxSchema = createInsertSchema(walletTransactionsTable).omit({ id: true, createdAt: true });
export type InsertWalletTx = z.infer<typeof insertWalletTxSchema>;
export type WalletTransaction = typeof walletTransactionsTable.$inferSelect;
