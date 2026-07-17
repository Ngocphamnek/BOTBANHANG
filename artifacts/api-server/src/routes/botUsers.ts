import { Router } from "express";
import { db, botUsersTable } from "@workspace/db";
import { asc } from "drizzle-orm";

const router = Router();

router.get("/bot-users", async (_req, res) => {
  const users = await db.select().from(botUsersTable).orderBy(asc(botUsersTable.createdAt));
  res.json(users.map((u) => ({
    ...u,
    telegramId: Number(u.telegramId),
    createdAt: u.createdAt.toISOString(),
  })));
});

export default router;
