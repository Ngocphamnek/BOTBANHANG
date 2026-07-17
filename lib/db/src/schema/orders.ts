import { pgTable, serial, text, integer, timestamp, bigint, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productsTable } from "./products";

export const orderStatusEnum = pgEnum("order_status", ["pending_payment", "paid", "delivered", "cancelled"]);

export const ordersTable = pgTable("orders", {
  id: serial("id").primaryKey(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).default(0).notNull(),
  telegramUsername: text("telegram_username"),
  productId: integer("product_id").references(() => productsTable.id),   // nullable — gcmmo orders may not match
  productName: text("product_name"),                                       // fallback product name from gcmmo
  quantity: integer("quantity").notNull().default(1),
  totalPrice: integer("total_price").notNull(),
  status: orderStatusEnum("status").notNull().default("pending_payment"),
  paymentMethod: text("payment_method"),
  deliveredItems: text("delivered_items"),   // JSON string of delivered content
  gcmmoOrderId: text("gcmmo_order_id"),      // ID đơn hàng từ gcmmo.net (unique)
  source: text("source").default("bot"),     // 'bot' | 'gcmmo'
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertOrderSchema = createInsertSchema(ordersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof ordersTable.$inferSelect;
