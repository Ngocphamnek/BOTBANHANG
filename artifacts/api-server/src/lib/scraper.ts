import * as cheerio from "cheerio";
import { db, productsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

const BASE_URL = "https://gcmmo.net";

async function fetchHtml(url: string, cookies?: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "vi-VN,vi;q=0.9",
      ...(cookies ? { Cookie: cookies } : {}),
    },
  });
  return res.text();
}

export async function syncFromGcmmo(): Promise<{ synced: number; message: string }> {
  const gcmmoCookies = process.env.GCMMO_SESSION_COOKIES;

  try {
    const html = await fetchHtml(`${BASE_URL}/products`, gcmmoCookies);
    const $ = cheerio.load(html);

    const scraped: Array<{ name: string; price: number; category: string; sourceId: string; imageUrl: string }> = [];

    $("a[href*='/products/']").each((_i, el) => {
      const href = $(el).attr("href") ?? "";
      const sourceId = href.split("/products/")[1]?.split("?")[0] ?? "";
      if (!sourceId) return;

      const name = $(el).find("h2, h3, .name, [class*='name'], [class*='title']").first().text().trim()
        || $(el).text().trim();
      const priceText = $(el).find("[class*='price'], .price").first().text().trim();
      const price = parseInt(priceText.replace(/[^\d]/g, "")) || 0;
      const imageUrl = $(el).find("img").first().attr("src") ?? "";
      const category = $(el).closest("[class*='category']").find("h2, h3").first().text().trim() || "Chung";

      if (name && name.length > 2) {
        scraped.push({ name, price, category, sourceId, imageUrl: imageUrl.startsWith("http") ? imageUrl : `${BASE_URL}${imageUrl}` });
      }
    });

    if (scraped.length === 0) {
      logger.warn({ url: `${BASE_URL}/products` }, "No products scraped - site structure may have changed");
      return { synced: 0, message: "Không tìm thấy sản phẩm. Cấu trúc trang web có thể đã thay đổi hoặc cần đăng nhập." };
    }

    let synced = 0;
    for (const item of scraped) {
      const existing = await db.query.productsTable.findFirst({
        where: eq(productsTable.sourceId, item.sourceId),
      });

      if (existing) {
        await db.update(productsTable).set({
          name: item.name,
          price: item.price,
          imageUrl: item.imageUrl,
          updatedAt: new Date(),
        }).where(eq(productsTable.id, existing.id));
      } else {
        await db.insert(productsTable).values({
          name: item.name,
          price: item.price,
          category: item.category,
          sourceId: item.sourceId,
          imageUrl: item.imageUrl,
          isActive: true,
        });
        synced++;
      }
    }

    logger.info({ synced, total: scraped.length }, "Sync complete");
    return { synced, message: `Đồng bộ thành công: ${synced} sản phẩm mới, ${scraped.length - synced} đã cập nhật.` };
  } catch (err) {
    logger.error({ err }, "Scraper error");
    throw err;
  }
}
