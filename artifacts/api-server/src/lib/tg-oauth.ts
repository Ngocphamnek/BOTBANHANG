/**
 * Shared Telegram OAuth logic — dùng bởi cả route gcmmo-auth và bot
 */

import { logger } from "./logger.js";

const TG_OAUTH_BASE = "https://oauth.telegram.org";
const GCMMO_BASE = "https://gcmmo.net";
const BOT_ID = "8657247737";
const TG_PARAMS = `bot_id=${BOT_ID}&origin=https%3A%2F%2Fgcmmo.net&embed=1&return_to=https%3A%2F%2Fgcmmo.net%2Flogin`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function cookiesFromHeaders(headers: Headers): string {
  const all: string[] = [];
  if (typeof (headers as any).getSetCookie === "function") {
    for (const h of (headers as any).getSetCookie() as string[]) all.push(h.split(";")[0]);
  } else {
    const raw = headers.get("set-cookie") ?? "";
    for (const part of raw.split(",")) {
      const kv = part.trim().split(";")[0].trim();
      if (kv) all.push(kv);
    }
  }
  return all.join("; ");
}

function mergeCookies(base: string, incoming: string): string {
  const map = new Map<string, string>();
  for (const part of [...base.split(";"), ...incoming.split(";")]) {
    const kv = part.trim();
    if (!kv) continue;
    const eq = kv.indexOf("=");
    const key = eq >= 0 ? kv.slice(0, eq).trim() : kv;
    map.set(key, kv);
  }
  return [...map.values()].join("; ");
}

function normalizePhone(raw: string): string {
  let p = raw.replace(/[^0-9]/g, "");
  if (p.startsWith("0") && p.length === 10) p = "84" + p.slice(1);
  return p;
}

export interface TgSession {
  sessionId: string;
  cookies: string;
  phone: string;
  createdAt: number;
}

// ─── Bước 1: Gửi SĐT → Telegram gửi thông báo về app ─────────────────────────
export async function tgAuthStart(phone: string): Promise<{ ok: true; session: TgSession } | { ok: false; error: string }> {
  const normalized = normalizePhone(phone);
  try {
    let initCookies = "";
    try {
      const initR = await fetch(`${TG_OAUTH_BASE}/auth?${TG_PARAMS}`, {
        headers: { "User-Agent": UA, Accept: "text/html", Referer: "https://gcmmo.net/login" },
        redirect: "follow",
      });
      initCookies = cookiesFromHeaders(initR.headers);
    } catch { /* bỏ qua */ }

    const r = await fetch(`${TG_OAUTH_BASE}/auth/request?${TG_PARAMS}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": UA,
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: `https://oauth.telegram.org/auth?${TG_PARAMS}`,
        Origin: "https://oauth.telegram.org",
        ...(initCookies ? { Cookie: initCookies } : {}),
      },
      body: `phone=${encodeURIComponent(normalized)}`,
    });

    const newCookies = cookiesFromHeaders(r.headers);
    const cookies = mergeCookies(initCookies, newCookies);
    const body = await r.text();

    logger.info({ phone: normalized, status: r.status, body }, "tg-oauth: start response");

    if (body !== "true") {
      return { ok: false, error: `Telegram từ chối: ${body}` };
    }

    const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return { ok: true, session: { sessionId, cookies, phone: normalized, createdAt: Date.now() } };
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
}

// ─── Bước 2: Poll xem user đã xác nhận chưa ──────────────────────────────────
export interface TgUserData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export async function tgAuthPoll(session: TgSession): Promise<
  { status: "waiting"; session: TgSession } |
  { status: "confirmed"; user: TgUserData } |
  { status: "expired" }
> {
  try {
    const r = await fetch(`${TG_OAUTH_BASE}/auth/login?${TG_PARAMS}`, {
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": UA,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://oauth.telegram.org/",
        Origin: "https://oauth.telegram.org",
        Cookie: session.cookies,
      },
      body: "",
    });

    const raw = await r.text();
    const newCookies = cookiesFromHeaders(r.headers);
    const updatedSession = { ...session, cookies: mergeCookies(session.cookies, newCookies) };

    if (raw === "Session expired") return { status: "expired" };
    if (!raw || raw.trim() === "false" || raw.trim() === "null") return { status: "waiting", session: updatedSession };

    // Confirmed → lấy user data
    let data: any = null;
    if (raw.trim() === "true") {
      const gr = await fetch(`${TG_OAUTH_BASE}/auth/get?${TG_PARAMS}`, {
        method: "POST",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": UA,
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://oauth.telegram.org/",
          Origin: "https://oauth.telegram.org",
          Cookie: updatedSession.cookies,
        },
        body: "",
      });
      const graw = await gr.text();
      try { data = JSON.parse(graw); } catch { data = null; }
      if (data?.user?.id) data = data.user;

      // Fallback widget_login nếu NOT_AUTHORIZED
      if (data?.error === "NOT_AUTHORIZED") {
        const wr = await fetch(`${TG_OAUTH_BASE}/auth/widget_login?${TG_PARAMS}`, {
          method: "POST",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": UA,
            Accept: "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: "https://oauth.telegram.org/",
            Origin: "https://oauth.telegram.org",
            Cookie: updatedSession.cookies,
          },
          body: "",
        });
        try { data = JSON.parse(await wr.text()); } catch { data = null; }
      }
    } else {
      try { data = JSON.parse(raw); } catch { data = null; }
      if (data?.user?.id) data = data.user;
    }

    if (!data?.id) return { status: "waiting", session: updatedSession };
    return { status: "confirmed", user: data as TgUserData };
  } catch {
    return { status: "waiting", session };
  }
}

// ─── Bước 3: Đổi Telegram user data lấy gcmmo token ─────────────────────────
export async function gcmmoLogin(user: TgUserData): Promise<
  { ok: true; access_token?: string; refresh_token?: string } |
  { ok: false; error: string }
> {
  try {
    // Lấy session cookie + state từ gcmmo
    let sessionCookies = "";
    try {
      const loginPage = await fetch(`${GCMMO_BASE}/login`, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        redirect: "follow",
      });
      sessionCookies = cookiesFromHeaders(loginPage.headers);
    } catch { /* bỏ qua */ }

    let state = "";
    try {
      const sr = await fetch(`${GCMMO_BASE}/api/auth/telegram/start`, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Referer: `${GCMMO_BASE}/login`,
          ...(sessionCookies ? { Cookie: sessionCookies } : {}),
        },
      });
      const startCookies = cookiesFromHeaders(sr.headers);
      if (startCookies) sessionCookies = mergeCookies(sessionCookies, startCookies);
      if (sr.ok) {
        const sd = await sr.json() as any;
        state = sd.state ?? sd.data?.state ?? sd.csrfToken ?? "";
      }
    } catch { /* bỏ qua */ }

    const body = {
      state,
      id: String(user.id),
      first_name: user.first_name,
      last_name: user.last_name ?? "",
      username: user.username ?? "",
      photo_url: user.photo_url ?? "",
      auth_date: String(user.auth_date),
      hash: user.hash,
    };

    const r = await fetch(`${GCMMO_BASE}/api/auth/telegram/callback`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: GCMMO_BASE,
        Referer: `${GCMMO_BASE}/login`,
        ...(sessionCookies ? { Cookie: sessionCookies } : {}),
      },
      body: JSON.stringify(body),
    });

    const callbackCookies = cookiesFromHeaders(r.headers);
    const raw = await r.text();
    let data: any;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    // Log toàn bộ để debug
    logger.info({
      status: r.status,
      rawBody: raw.slice(0, 500),
      dataKeys: data ? Object.keys(data) : [],
      callbackCookies: callbackCookies.slice(0, 300),
    }, "gcmmo-login: callback raw response");

    if (!r.ok) return { ok: false, error: data?.error ?? raw.slice(0, 200) };

    // Thử lấy token từ mọi vị trí có thể trong response body
    let accessToken: string | undefined =
      data?.access_token ??
      data?.accessToken ??
      data?.token ??
      data?.data?.access_token ??
      data?.data?.accessToken ??
      data?.data?.token ??
      data?.authResponse?.access_token ??
      data?.authResponse?.accessToken ??
      data?.auth?.access_token ??
      data?.auth?.token ??
      data?.result?.access_token ??
      data?.payload?.access_token ??
      data?.user?.access_token ??
      data?.session?.access_token;

    let refreshToken: string | undefined =
      data?.refresh_token ??
      data?.refreshToken ??
      data?.data?.refresh_token ??
      data?.data?.refreshToken ??
      data?.authResponse?.refresh_token ??
      data?.auth?.refresh_token;

    logger.info({ accessToken: accessToken ? accessToken.slice(0, 20) + "..." : null, rawDataPreview: JSON.stringify(data).slice(0, 300) }, "gcmmo-login: token extraction");

    // Thử lấy từ cookie response (bao gồm hmmo.accessToken, hmmo.refreshToken)
    if (!accessToken && callbackCookies) {
      const cookieParts = callbackCookies.split(";").map(s => s.trim());
      for (const part of cookieParts) {
        const eqIdx = part.indexOf("=");
        if (eqIdx < 0) continue;
        const key = part.slice(0, eqIdx).trim().toLowerCase();
        const val = part.slice(eqIdx + 1).trim();
        if (val.length < 20) continue;
        // gcmmo dùng cookie hmmo.accessToken và hmmo.refreshToken
        if (["hmmo.accesstoken", "token", "access_token", "accesstoken", "jwt", "bearer"].includes(key)) {
          accessToken = val;
          logger.info({ cookieKey: key }, "gcmmo-login: token found in response cookie");
        }
        if (["hmmo.refreshtoken", "refresh_token", "refreshtoken"].includes(key) && !refreshToken) {
          refreshToken = val;
        }
      }
    }

    // Follow redirect — gcmmo có thể set cookie rồi redirect về "/"
    // Sau redirect, dùng merged cookies gọi các endpoint để lấy token
    const merged = mergeCookies(sessionCookies, callbackCookies);
    if (!accessToken) {
      const probeUrls = [
        `${GCMMO_BASE}/api/auth/me`,
        `${GCMMO_BASE}/api/user`,
        `${GCMMO_BASE}/api/auth/token`,
        `${GCMMO_BASE}/api/auth/access-token`,
        `${GCMMO_BASE}/api/session`,
      ];
      for (const url of probeUrls) {
        try {
          const mr = await fetch(url, {
            headers: { "User-Agent": UA, Accept: "application/json", Cookie: merged },
          });
          const mraw = await mr.text();
          logger.info({ url, status: mr.status, body: mraw.slice(0, 200) }, "gcmmo-login: probe endpoint");
          if (mr.ok) {
            const md = await (async () => { try { return JSON.parse(mraw); } catch { return null; } })();
            const t = md?.access_token ?? md?.accessToken ?? md?.token ?? md?.data?.access_token ?? md?.data?.token;
            if (t) { accessToken = t; break; }
          }
        } catch { /* ignore */ }
      }
    }

    // Nếu có redirect_to, follow redirect để thử lấy token
    if (!accessToken && data?.redirect_to) {
      try {
        const redirectUrl = data.redirect_to.startsWith("http")
          ? data.redirect_to
          : `${GCMMO_BASE}${data.redirect_to}`;
        const rr = await fetch(redirectUrl, {
          headers: { "User-Agent": UA, Accept: "text/html,application/json", Cookie: merged },
          redirect: "manual",
        });
        const redirectCookies = cookiesFromHeaders(rr.headers);
        logger.info({ redirectUrl, status: rr.status, cookies: redirectCookies.slice(0, 200) }, "gcmmo-login: followed redirect");

        // Kiểm tra hmmo.accessToken trong cookie của redirect
        for (const part of redirectCookies.split(";").map(s => s.trim())) {
          const eqIdx = part.indexOf("=");
          if (eqIdx < 0) continue;
          const key = part.slice(0, eqIdx).trim().toLowerCase();
          const val = part.slice(eqIdx + 1).trim();
          if (val.length < 20) continue;
          if (["hmmo.accesstoken"].includes(key)) {
            accessToken = val;
            logger.info({ cookieKey: key }, "gcmmo-login: token found in redirect cookie");
          }
          if (["hmmo.refreshtoken"].includes(key) && !refreshToken) refreshToken = val;
        }
      } catch (e) {
        logger.warn({ err: e }, "gcmmo-login: redirect follow failed");
      }
    }

    // Lưu vào DB để tồn tại qua restart
    if (accessToken) {
      const { setGcmmoTokens } = await import("./gcmmo-api.js");
      await setGcmmoTokens(accessToken, refreshToken);
    }

    logger.info({ hasToken: !!accessToken }, "gcmmo-login: done");
    return { ok: true, access_token: accessToken, refresh_token: refreshToken };
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
}
