import { Router } from "express";
import { eq, sql, gte } from "drizzle-orm";
import { db, productsTable, inventoryItemsTable, ordersTable, botUsersTable } from "@workspace/db";

const router = Router();

// GET /stats
router.get("/stats", async (_req, res) => {
  const [[revenue], [pendingOrders], [totalProducts], [totalInventory], [totalUsers], [todayOrders]] = await Promise.all([
    db.select({ v: sql<number>`coalesce(cast(sum(${ordersTable.totalPrice}) as int), 0)` })
      .from(ordersTable).where(eq(ordersTable.status, "delivered")),
    db.select({ v: sql<number>`cast(count(*) as int)` })
      .from(ordersTable).where(eq(ordersTable.status, "pending_payment")),
    db.select({ v: sql<number>`cast(count(*) as int)` })
      .from(productsTable).where(eq(productsTable.isActive, true)),
    db.select({ v: sql<number>`cast(count(*) as int)` })
      .from(inventoryItemsTable).where(eq(inventoryItemsTable.status, "available")),
    db.select({ v: sql<number>`cast(count(*) as int)` }).from(botUsersTable),
    db.select({ v: sql<number>`cast(count(*) as int)` })
      .from(ordersTable)
      .where(gte(ordersTable.createdAt, sql`current_date`)),
  ]);

  res.json({
    totalRevenue: revenue!.v,
    pendingOrders: pendingOrders!.v,
    totalProducts: totalProducts!.v,
    totalInventory: totalInventory!.v,
    totalUsers: totalUsers!.v,
    todayOrders: todayOrders!.v,
  });
});

// GET /revenue-chart
router.get("/revenue-chart", async (_req, res) => {
  const rows = await db.execute(sql`
    SELECT
      to_char(d::date, 'YYYY-MM-DD') as date,
      coalesce(cast(sum(o.total_price) as int), 0) as revenue,
      cast(count(o.id) as int) as orders
    FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') d
    LEFT JOIN orders o ON o.created_at::date = d::date AND o.status = 'delivered'
    GROUP BY d ORDER BY d
  `);

  res.json(rows.rows);
});

export default router;
