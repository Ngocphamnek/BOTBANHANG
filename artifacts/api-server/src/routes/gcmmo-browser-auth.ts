import { Router } from "express";
import { chromium } from "playwright-core";
import { logger } from "../lib/logger.js";

const router = Router();

const CHROMIUM_PATH =
  "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome";

interface BrowserSession {
  sessionId: string;
  status: "waiting_confirm" | "success" | "error";
  token?: string;
  refreshToken?: string;
  error?: string;
  createdAt: number;
  cleanup?: () => Promise<void>;
}

const sessions = new Map<string, BrowserSession>();

// Cleanup sessions > 10 phút
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of sessions.entries()) {
    if (v.createdAt < cutoff) {
      v.cleanup?.().catch(() => {});
      sessions.delete(k);
    }
  }
}, 60_000);

function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// POST /api/gcmmo-browser-auth/start  { phone }
// Mở headless Chromium, điều hướng tới Telegram widget, nhập SĐT
router.post("/start", async (req, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) return res.status(400).json({ ok: false, error: "Thiếu số điện thoại" });

  // Chuẩn hoá số điện thoại
  let normalized = phone.replace(/[^0-9+]/g, "");
  if (normalized.startsWith("0") && normalized.length === 10) {
    normalized = "+84" + normalized.slice(1);
  } else if (!normalized.startsWith("+")) {
    normalized = "+" + normalized;
  }

  const sessionId = newId();
  const session: BrowserSession = { sessionId, status: "waiting_confirm", createdAt: Date.now() };
  sessions.set(sessionId, session);

  // Chạy async, không block response
  (async () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      logger.info({ sessionId, phone: normalized }, "browser-auth: launching Chromium");

      browser = await chromium.launch({
        executablePath: CHROMIUM_PATH,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled",
        ],
      });

      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        locale: "vi-VN",
        timezoneId: "Asia/Ho_Chi_Minh",
      });

      // Intercept network để bắt token từ response
      let capturedToken: string | undefined;
      let capturedRefresh: string | undefined;

      context.on("response", async (response) => {
        try {
          const url = response.url();
          if (
            url.includes("/v1/auth") ||
            url.includes("/api/auth/") ||
            url.includes("/login") ||
            url.includes("/token")
          ) {
            const ct = response.headers()["content-type"] ?? "";
            if (ct.includes("json")) {
              const body = await response.json().catch(() => null);
              if (body) {
                const token =
                  body.accessToken ??
                  body.access_token ??
                  body.token ??
                  body.data?.accessToken ??
                  body.data?.access_token;
                const refresh =
                  body.refreshToken ??
                  body.refresh_token ??
                  body.data?.refreshToken ??
                  body.data?.refresh_token;
                if (token) {
                  logger.info({ url }, "browser-auth: captured token from response");
                  capturedToken = token;
                  if (refresh) capturedRefresh = refresh;
                }
              }
            }
          }
        } catch { /* ignore */ }
      });

      const page = await context.newPage();

      // Giả lập browser thật — ẩn dấu hiệu automation
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        (window as any).chrome = { runtime: {} };
      });

      // Điều hướng THẲNG tới trang Telegram OAuth (không đi qua gcmmo.net/login)
      // Telegram sẽ show form nhập SĐT → user confirm → redirect về gcmmo.net
      const TG_PARAMS = `bot_id=8657247737&origin=https%3A%2F%2Fgcmmo.net&embed=0&return_to=https%3A%2F%2Fgcmmo.net%2Fapi%2Fauth%2Ftelegram%2Fcallback`;
      const tgAuthUrl = `https://oauth.telegram.org/auth?${TG_PARAMS}`;

      logger.info({ sessionId, url: tgAuthUrl }, "browser-auth: navigating directly to Telegram OAuth");
      await page.goto(tgAuthUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1500);

      logger.info({ sessionId, url: page.url() }, "browser-auth: page loaded");

      // Tìm ô nhập SĐT trong trang Telegram OAuth
      const phoneInput = page.locator(
        "input[type='tel'], input[name='phone'], input[placeholder*='phone'], input[placeholder*='Phone'], input[id*='phone']"
      ).first();

      await phoneInput.waitFor({ state: "visible", timeout: 15_000 });
      await phoneInput.fill(normalized);
      logger.info({ sessionId }, "browser-auth: filled phone number in Telegram OAuth page");

      // Click submit button (kích hoạt JavaScript handler của widget, không phải native form submit)
      // Native form submit (Enter) sẽ navigate thẳng đến return_to URL mà không qua Telegram auth
      const submitBtn = page.locator([
        "button[type='submit']",
        "button.btn-primary",
        ".tgme_widget_login_button",
        "form button",
        "input[type='submit']",
      ].join(", ")).first();

      let clickedBtn = false;
      try {
        await submitBtn.waitFor({ state: "visible", timeout: 5_000 });
        await submitBtn.click();
        clickedBtn = true;
        logger.info({ sessionId }, "browser-auth: clicked submit button");
      } catch {
        // Fallback: Enter key nếu không tìm được button
        await phoneInput.press("Enter");
        logger.info({ sessionId }, "browser-auth: pressed Enter (button not found)");
      }

      // Chờ 1 giây để trang xử lý submission
      await page.waitForTimeout(1000);

      // Kiểm tra nếu bị bounce ngay (navigate đến gcmmo.net rồi quay về oauth.telegram.org)
      // → tức là submission thất bại, thử lại bằng Enter nếu đã click button
      const urlAfterSubmit = page.url();
      if (clickedBtn && urlAfterSubmit.includes("oauth.telegram.org")) {
        // Button click đã xử lý đúng (vẫn trên trang OAuth = đang chờ xác nhận Telegram)
        logger.info({ sessionId }, "browser-auth: still on OAuth page — waiting for Telegram app confirmation...");
      } else if (!urlAfterSubmit.includes("oauth.telegram.org") && !urlAfterSubmit.includes("gcmmo.net")) {
        logger.info({ sessionId, url: urlAfterSubmit }, "browser-auth: navigated to unexpected URL");
      }

      logger.info({ sessionId }, "browser-auth: polling for token — user must confirm in Telegram app...");

      // Polling loop — đợi user xác nhận trên app Telegram (tối đa 3 phút)
      // Không dùng waitForURL vì nó resolve ngay lần redirect đầu (kể cả khi bị bounce về)
      const deadline = Date.now() + 180_000;
      let pollTick = 0;

      while (!capturedToken && Date.now() < deadline) {
        await page.waitForTimeout(3_000);
        pollTick++;

        if (capturedToken) break; // network interceptor đã bắt được

        const currentUrl = page.url();

        // Nếu đang trên gcmmo.net (redirect thành công từ Telegram OAuth)
        if (currentUrl.includes("gcmmo.net")) {
          await page.waitForLoadState("networkidle").catch(() => {});

          // Thử lấy token từ localStorage
          const lsToken = await page.evaluate(() => {
            const keys = ["accessToken", "token", "access_token", "auth_token", "userToken"];
            for (const k of keys) {
              const v = localStorage.getItem(k);
              if (v && v.length > 20) return v as string;
            }
            return null;
          }).catch(() => null) ?? undefined;

          if (lsToken) { capturedToken = lsToken; break; }

          // Thử lấy từ cookie gcmmo.net
          const gcmmoCookies = await context.cookies("https://gcmmo.net");
          const tokenCookie = gcmmoCookies.find((c) =>
            ["token", "access_token", "accessToken", "auth", "session"].includes(c.name)
          );
          if (tokenCookie) { capturedToken = tokenCookie.value; break; }
        }

        if (pollTick % 5 === 0) {
          logger.info({ sessionId, currentUrl, elapsed: `${Math.round((Date.now() - (deadline - 180_000)) / 1000)}s` }, "browser-auth: still waiting for confirmation...");
        }
      }

      const finalUrl = page.url();
      logger.info({ sessionId, finalUrl, found: !!capturedToken }, "browser-auth: polling done");

      // Lần cuối kiểm tra cookie
      if (!capturedToken) {
        const cookies = await context.cookies("https://gcmmo.net");
        logger.info({ cookieNames: cookies.map(c => c.name) }, "browser-auth: gcmmo cookies");
        const tokenCookie = cookies.find((c) =>
          ["token", "access_token", "accessToken", "auth", "session"].includes(c.name)
        );
        if (tokenCookie) capturedToken = tokenCookie.value;
      }

      if (capturedToken) {
        process.env["GCMMO_ACCESS_TOKEN"] = capturedToken;
        if (capturedRefresh) process.env["GCMMO_REFRESH_TOKEN"] = capturedRefresh;
        session.status = "success";
        session.token = capturedToken;
        session.refreshToken = capturedRefresh;
        logger.info({ sessionId }, "browser-auth: SUCCESS — token captured");
      } else {
        session.status = "error";
        session.error = "Đã xác nhận nhưng không lấy được token. Thử dùng phương thức thủ công.";
        logger.warn({ sessionId }, "browser-auth: confirmed but no token found");
      }

      await browser.close();
    } catch (err: any) {
      logger.error({ err, sessionId }, "browser-auth: error");
      session.status = "error";
      session.error = String(err?.message ?? err).slice(0, 300);
      await browser?.close().catch(() => {});
    }
  })();

  return res.json({ ok: true, sessionId });
});

// GET /api/gcmmo-browser-auth/poll/:sessionId
router.get("/poll/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: "Session không tồn tại hoặc đã hết hạn" });

  if (session.status === "waiting_confirm") {
    return res.json({ ok: true, status: "waiting" });
  }
  if (session.status === "success") {
    sessions.delete(req.params.sessionId);
    return res.json({ ok: true, status: "success", token: session.token, refreshToken: session.refreshToken });
  }
  sessions.delete(req.params.sessionId);
  return res.json({ ok: false, error: session.error ?? "Lỗi không xác định" });
});

export default router;
