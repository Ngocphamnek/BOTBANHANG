import { Router } from "express";
import { logger } from "../lib/logger.js";
import { tgAuthStart, tgAuthPoll, gcmmoLogin } from "../lib/tg-oauth.js";

const router = Router();

const GCMMO_BASE = "https://gcmmo.net";
const TG_OAUTH_BASE = "https://oauth.telegram.org";
const BOT_ID = "8657247737";
const TG_PARAMS = `bot_id=${BOT_ID}&origin=https%3A%2F%2Fgcmmo.net&embed=1&return_to=https%3A%2F%2Fgcmmo.net%2Flogin`;

// ─── Session stores ────────────────────────────────────────────────────────────

interface TgSession {
  cookies: string;
  phone: string;
  createdAt: number;
}
const tgSessions = new Map<string, TgSession>();

interface RelayEntry {
  token: string;
  refreshToken?: string;
  receivedAt: number;
}
const relayStore = new Map<string, RelayEntry>();

// Cleanup old entries
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of tgSessions.entries()) if (v.createdAt < cutoff) tgSessions.delete(k);
  for (const [k, v] of relayStore.entries()) if (v.receivedAt < cutoff) relayStore.delete(k);
}, 60_000);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function normalizePhone(raw: string): string {
  let p = raw.replace(/[^0-9]/g, "");
  // Vietnamese: 0988... → 84988...
  if (p.startsWith("0") && p.length === 10) p = "84" + p.slice(1);
  return p;
}

function mergeCookies(base: string, incoming: string): string {
  const map = new Map<string, string>();
  for (const part of base.split(";")) {
    const kv = part.trim();
    if (kv) {
      const eq = kv.indexOf("=");
      const key = eq >= 0 ? kv.slice(0, eq) : kv;
      map.set(key.trim(), kv);
    }
  }
  for (const part of incoming.split(";")) {
    const kv = part.trim();
    if (kv) {
      const eq = kv.indexOf("=");
      const key = eq >= 0 ? kv.slice(0, eq) : kv;
      map.set(key.trim(), kv);
    }
  }
  return [...map.values()].join("; ");
}

function cookiesFromHeaders(headers: Headers): string {
  const all: string[] = [];
  // Node 18+ supports getSetCookie
  if (typeof (headers as any).getSetCookie === "function") {
    for (const h of (headers as any).getSetCookie() as string[]) {
      all.push(h.split(";")[0]);
    }
  } else {
    const raw = headers.get("set-cookie") ?? "";
    for (const part of raw.split(",")) {
      const kv = part.trim().split(";")[0].trim();
      if (kv) all.push(kv);
    }
  }
  return all.join("; ");
}

async function callGcmmoCallback(authData: Record<string, any>) {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // Bước 1: Mở gcmmo.net/login để lấy session cookie (giống browser thật)
  let sessionCookies = "";
  try {
    const loginPage = await fetch(`${GCMMO_BASE}/login`, {
      method: "GET",
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
    });
    sessionCookies = cookiesFromHeaders(loginPage.headers);
    logger.info({ cookiesLen: sessionCookies.length }, "gcmmo callback: got login page cookies");
  } catch (e) {
    logger.warn({ err: e }, "gcmmo callback: failed to get login page, continuing without cookies");
  }

  // Bước 2: Gọi /api/auth/telegram/start với session cookie → lấy state CSRF
  let state = "";
  try {
    const sr = await fetch(`${GCMMO_BASE}/api/auth/telegram/start`, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: `${GCMMO_BASE}/login`,
        ...(sessionCookies ? { Cookie: sessionCookies } : {}),
      },
    });
    // Merge cookies mới từ /start vào session
    const startCookies = cookiesFromHeaders(sr.headers);
    if (startCookies) sessionCookies = mergeCookies(sessionCookies, startCookies);

    if (sr.ok) {
      const sd = await sr.json() as any;
      state = sd.state ?? sd.data?.state ?? sd.csrfToken ?? sd.csrf_token ?? "";
      logger.info({ state: state.slice(0, 20) + "...", cookiesLen: sessionCookies.length }, "gcmmo callback: got state");
    }
  } catch (e) {
    logger.warn({ err: e }, "gcmmo callback: failed to get state, using empty");
  }

  // Bước 3: Gọi callback với session cookie + state
  const body = {
    state,
    id: String(authData.id ?? ""),
    first_name: authData.first_name ?? "",
    last_name: authData.last_name ?? "",
    username: authData.username ?? "",
    photo_url: authData.photo_url ?? "",
    auth_date: String(authData.auth_date ?? ""),
    hash: authData.hash ?? "",
  };

  logger.info({ body: { ...body, hash: body.hash.slice(0, 10) + "..." } }, "gcmmo callback: sending");

  const r = await fetch(`${GCMMO_BASE}/api/auth/telegram/callback`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": UA,
      Origin: "https://gcmmo.net",
      Referer: "https://gcmmo.net/login",
      ...(sessionCookies ? { Cookie: sessionCookies } : {}),
    },
    body: JSON.stringify(body),
  });

  const raw = await r.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = { raw }; }

  // Lấy cookies từ response của callback (gcmmo có thể set token trong cookie)
  const callbackCookies = cookiesFromHeaders(r.headers);
  logger.info({ status: r.status, data, callbackCookies: callbackCookies.slice(0, 200) }, "gcmmo callback: response");

  if (!r.ok) {
    logger.warn({ status: r.status, data }, "gcmmo callback failed");
    return { ok: false as const, error: data?.error ?? data?.message ?? raw.slice(0, 200) };
  }

  // Thử lấy token từ JSON body trước
  let accessToken: string | undefined =
    data?.access_token ?? data?.accessToken ?? data?.data?.access_token ?? data?.data?.accessToken ?? data?.token;
  let refreshToken: string | undefined =
    data?.refresh_token ?? data?.refreshToken ?? data?.data?.refresh_token ?? data?.data?.refreshToken;

  // Nếu JSON không có token → tìm trong cookies response
  if (!accessToken && callbackCookies) {
    const cookieParts = callbackCookies.split(";").map(s => s.trim());
    for (const part of cookieParts) {
      const [k, v] = part.split("=");
      const key = k?.trim().toLowerCase() ?? "";
      const val = v?.trim() ?? "";
      if (!val || val.length < 20) continue;
      if (["token", "access_token", "accesstoken", "auth_token", "jwt", "bearer"].includes(key)) {
        accessToken = val;
      }
      if (["refresh_token", "refreshtoken"].includes(key) && !refreshToken) {
        refreshToken = val;
      }
    }
    if (accessToken) logger.info("gcmmo callback: token found in cookie");
  }

  // Nếu gcmmo trả redirect_to "/" → đăng nhập thành công nhưng token được quản lý qua cookie session
  // Trong trường hợp đó, cần follow redirect để lấy token từ trang đích
  if (!accessToken && data?.redirect_to) {
    logger.info({ redirect_to: data.redirect_to }, "gcmmo callback: following redirect to get token");
    try {
      const mergedCookies = mergeCookies(sessionCookies, callbackCookies);
      const redirectUrl = data.redirect_to.startsWith("http")
        ? data.redirect_to
        : `${GCMMO_BASE}${data.redirect_to}`;
      const rr = await fetch(redirectUrl, {
        method: "GET",
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Cookie: mergedCookies,
          Referer: `${GCMMO_BASE}/login`,
        },
      });
      const redirectCookies = cookiesFromHeaders(rr.headers);
      const rrData = await rr.json().catch(() => null) as any;
      logger.info({ status: rr.status, rrData, redirectCookies: redirectCookies.slice(0, 200) }, "gcmmo callback: redirect response");

      if (rrData) {
        accessToken = accessToken ??
          rrData?.access_token ?? rrData?.accessToken ?? rrData?.data?.access_token ??
          rrData?.token ?? rrData?.data?.token;
        refreshToken = refreshToken ??
          rrData?.refresh_token ?? rrData?.refreshToken ?? rrData?.data?.refresh_token;
      }

      // Thử lấy từ /api/auth/me hoặc /api/user với cookie session sau redirect
      if (!accessToken) {
        const mergedAll = mergeCookies(mergedCookies, redirectCookies);
        for (const meUrl of [`${GCMMO_BASE}/api/auth/me`, `${GCMMO_BASE}/api/user`, `${GCMMO_BASE}/api/auth/token`]) {
          try {
            const mr = await fetch(meUrl, {
              headers: { "User-Agent": UA, Accept: "application/json", Cookie: mergedAll },
            });
            if (mr.ok) {
              const md = await mr.json().catch(() => null) as any;
              logger.info({ url: meUrl, status: mr.status, md }, "gcmmo callback: me endpoint");
              const t = md?.access_token ?? md?.accessToken ?? md?.token ?? md?.data?.access_token ?? md?.data?.token;
              if (t) { accessToken = t; break; }
            }
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      logger.warn({ err: e }, "gcmmo callback: redirect follow failed");
    }
  }

  // Lưu vào DB để tồn tại qua restart
  if (accessToken) {
    const { setGcmmoTokens } = await import("../lib/gcmmo-api.js");
    await setGcmmoTokens(accessToken, refreshToken).catch(() => {});
  }

  logger.info({ hasToken: !!accessToken, hasRefresh: !!refreshToken }, "gcmmo callback: done");
  return { ok: true as const, access_token: accessToken, refresh_token: refreshToken };
}

// ─── Routes ────────────────────────────────────────────────────────────────────

// POST /gcmmo-auth/tg-start  { phone }
// → gọi oauth.telegram.org, Telegram gửi xác nhận về app user
router.post("/tg-start", async (req, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) return res.status(400).json({ ok: false, error: "Thiếu số điện thoại" });

  const normalized = normalizePhone(phone);
  logger.info({ phone: normalized }, "tg-start: sending Telegram auth request");

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  try {
    // Bước 1: load trang widget để lấy session cookies khởi tạo
    let initCookies = "";
    try {
      const initR = await fetch(`${TG_OAUTH_BASE}/auth?${TG_PARAMS}`, {
        method: "GET",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: "https://gcmmo.net/login",
        },
        redirect: "follow",
      });
      initCookies = cookiesFromHeaders(initR.headers);
      logger.info({ status: initR.status, cookiesLen: initCookies.length }, "tg-start: widget init cookies");
    } catch (e) {
      logger.warn({ err: e }, "tg-start: widget init failed, proceeding without");
    }

    // Bước 2: gọi /auth/request với session cookies đã có
    const r = await fetch(
      `${TG_OAUTH_BASE}/auth/request?${TG_PARAMS}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": UA,
          Accept: "application/json, text/javascript, */*; q=0.01",
          Referer: "https://oauth.telegram.org/auth?" + TG_PARAMS,
          Origin: "https://oauth.telegram.org",
          ...(initCookies ? { Cookie: initCookies } : {}),
        },
        body: `phone=${encodeURIComponent(normalized)}`,
      }
    );

    const newCookies = cookiesFromHeaders(r.headers);
    const cookies = mergeCookies(initCookies, newCookies);
    const body = await r.text();

    logger.info({ status: r.status, body, cookiesLen: cookies.length }, "tg-start response");

    if (body !== "true") {
      return res.status(400).json({ ok: false, error: `Telegram từ chối: ${body}` });
    }

    const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    tgSessions.set(sessionId, { cookies, phone: normalized, createdAt: Date.now() });

    return res.json({ ok: true, sessionId });
  } catch (err) {
    logger.error({ err }, "tg-start error");
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /gcmmo-auth/tg-poll/:sessionId
// → poll oauth.telegram.org, khi user confirm trên app → lấy token gcmmo
router.get("/tg-poll/:sessionId", async (req, res) => {
  const session = tgSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: "Session không tồn tại hoặc đã hết hạn" });

  try {
    const r = await fetch(
      `${TG_OAUTH_BASE}/auth/login?${TG_PARAMS}`,
      {
        method: "POST",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://oauth.telegram.org/",
          Origin: "https://oauth.telegram.org",
          Cookie: session.cookies,
        },
        body: "",
      }
    );

    const raw = await r.text();
    // Cập nhật cookies mới từ /auth/login response (Telegram set cookies mới khi user confirm)
    const loginNewCookies = cookiesFromHeaders(r.headers);
    if (loginNewCookies) {
      // Merge: giữ cookies cũ, ghi đè bằng cookies mới
      const merged = mergeCookies(session.cookies, loginNewCookies);
      session.cookies = merged;
      tgSessions.set(req.params.sessionId, session);
    }
    logger.info({ status: r.status, raw: raw.slice(0, 300), newCookies: loginNewCookies.slice(0, 80) }, "tg-poll /auth/login response");

    // "false" hoặc rỗng → chưa confirm
    if (!raw || raw.trim() === "false" || raw.trim() === "null") {
      return res.json({ ok: true, ready: false });
    }

    // "true" → user đã confirm, cần gọi /auth/get để lấy user data
    let data: any = null;
    if (raw.trim() === "true") {
      const gr = await fetch(
        `${TG_OAUTH_BASE}/auth/get?${TG_PARAMS}`,
        {
          method: "POST",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: "https://oauth.telegram.org/",
            Origin: "https://oauth.telegram.org",
            Cookie: session.cookies,
          },
          body: "",
        }
      );
      const graw = await gr.text();
      logger.info({ status: gr.status, raw: graw.slice(0, 500) }, "tg-poll /auth/get response");
      try { data = JSON.parse(graw); } catch { data = null; }
      // /auth/get trả về { user: { id, ... } } — chuẩn hoá về flat object
      if (data?.user?.id) data = data.user;

      // Nếu vẫn NOT_AUTHORIZED → thử lại với /auth/widget_login (flow mới của Telegram)
      if (data?.error === "NOT_AUTHORIZED") {
        logger.info("NOT_AUTHORIZED from /auth/get, trying /auth/widget_login");
        const wr = await fetch(
          `${TG_OAUTH_BASE}/auth/widget_login?${TG_PARAMS}`,
          {
            method: "POST",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              Accept: "application/json, text/javascript, */*; q=0.01",
              "Content-Type": "application/x-www-form-urlencoded",
              Referer: "https://oauth.telegram.org/",
              Origin: "https://oauth.telegram.org",
              Cookie: session.cookies,
            },
            body: "",
          }
        );
        const wraw = await wr.text();
        logger.info({ status: wr.status, raw: wraw.slice(0, 500) }, "tg-poll /auth/widget_login response");
        try { data = JSON.parse(wraw); } catch { data = null; }
      }
    } else {
      // Có thể Telegram trả thẳng JSON user data
      try { data = JSON.parse(raw); } catch { data = null; }
    }

    if (!data || !data.id) {
      return res.json({ ok: true, ready: false });
    }

    logger.info({ id: data.id, username: data.username }, "Telegram auth confirmed!");
    tgSessions.delete(req.params.sessionId);

    // Exchange with gcmmo.net
    const result = await callGcmmoCallback(data);
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: result.error });
    }

    return res.json({ ok: true, ready: true, access_token: result.access_token, refresh_token: result.refresh_token });
  } catch (err) {
    logger.error({ err }, "tg-poll error");
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /gcmmo-auth/tg-debug/:sessionId  — xem raw Telegram response (dev only)
router.get("/tg-debug/:sessionId", async (req, res) => {
  const session = tgSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "session not found", knownSessions: [...tgSessions.keys()] });

  const commonHeaders = {
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: "https://oauth.telegram.org/",
    Origin: "https://oauth.telegram.org",
    Cookie: session.cookies,
  };

  const r1 = await fetch(`${TG_OAUTH_BASE}/auth/login?${TG_PARAMS}`, { method: "POST", headers: commonHeaders, body: "" });
  const login_raw = await r1.text();

  let get_raw = "(not called)";
  if (login_raw.trim() === "true") {
    const r2 = await fetch(`${TG_OAUTH_BASE}/auth/get?${TG_PARAMS}`, { method: "POST", headers: commonHeaders, body: "" });
    get_raw = await r2.text();
  }

  res.json({ login_raw, get_raw, cookies: session.cookies });
});

// GET /gcmmo-auth/relay?s=SESSION_ID&t=TOKEN&r=REFRESH_TOKEN  (CORS-free image trick)
router.get("/relay", async (req, res) => {
  const { s, t, r } = req.query as Record<string, string>;
  if (s && t) {
    relayStore.set(s, { token: t, refreshToken: r || undefined, receivedAt: Date.now() });
    const { setGcmmoTokens } = await import("../lib/gcmmo-api.js");
    await setGcmmoTokens(t, r || undefined).catch(() => {});
    logger.info({ session: s }, "GCMMO token received via relay — saved to DB");
  }
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(gif);
});

// GET /gcmmo-auth/relay-check/:sessionId
router.get("/relay-check/:sessionId", (req, res) => {
  const entry = relayStore.get(req.params.sessionId);
  if (!entry) return res.json({ ok: false, ready: false });
  relayStore.delete(req.params.sessionId);
  res.json({ ok: true, ready: true, access_token: entry.token, refresh_token: entry.refreshToken });
});

// POST /gcmmo-auth/save-token  { access_token, refresh_token }
router.post("/save-token", async (req, res) => {
  const { access_token, refresh_token } = req.body;
  if (!access_token) return res.status(400).json({ ok: false, error: "access_token là bắt buộc" });
  const { setGcmmoTokens } = await import("../lib/gcmmo-api.js");
  await setGcmmoTokens(access_token, refresh_token || undefined);
  return res.json({ ok: true });
});

export default router;
