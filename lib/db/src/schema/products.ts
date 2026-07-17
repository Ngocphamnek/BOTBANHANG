import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  price: integer("price").notNull(), // in VND — giá bán ra (có lời)
  gcmmoPrice: integer("gcmmo_price"), // giá gốc trên gcmmo.net (giá vốn)
  category: text("category"),
  sourceId: text("source_id"),         // gcmmo.net product id
  gcmmoVariantId: text("gcmmo_variant_id"), // gcmmo variant id (dùng khi mua)
  gcmmoSellerId: text("gcmmo_seller_id"),   // seller id trên gcmmo (dùng khi mua)
  gcmmoSellerSlug: text("gcmmo_seller_slug"),
  gcmmoSellerName: text("gcmmo_seller_name"),
  // Chất lượng shop — lưu tại thời điểm import, cập nhật mỗi lần sync
  sellerReviewCount: integer("seller_review_count").default(0),  // tổng lượt đánh giá của shop
  sellerRating: integer("seller_rating").default(0),             // rating * 10 (vd: 4.8 → 48) để tránh decimal
  sellerSoldCount: integer("seller_sold_count").default(0),      // tổng đơn hàng shop đã hoàn thành
  sellerPositiveRate: integer("seller_positive_rate").default(0),// % hài lòng (0–100)
  stock: integer("stock").default(0),  // tồn kho gcmmo (cập nhật khi sync)
  imageUrl: text("image_url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertProductSchema = createInsertSchema(productsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof productsTable.$inferSelect;
