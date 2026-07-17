import { useEffect, useRef, useState } from "react";
import {
  CheckCircle, TriangleAlert, KeyRound, Copy, ExternalLink,
  Eye, EyeOff, RefreshCw, Send, Bot,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const API = import.meta.env.BASE_URL?.replace(/\/$/, "") + "/api";
const POLL_MS = 3000;

// ─── helpers ────────────────────────────────────────────────────────────────

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">{n}</span>
      <p className="text-sm text-muted-foreground leading-relaxed">{text}</p>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border bg-background p-3 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-primary">{label}</span>
        <button
          onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? <CheckCircle size={12} className="text-primary" /> : <Copy size={12} />}
          {copied ? "Đã sao chép" : "Sao chép"}
        </button>
      </div>
      <p className="font-mono text-[10px] text-muted-foreground break-all leading-relaxed">
        {value.slice(0, 80)}{value.length > 80 ? "…" : ""}
      </p>
    </div>
  );
}

// ─── types ──────────────────────────────────────────────────────────────────

type Method = "choose" | "auto" | "manual";
type Phase  = "idle" | "loading" | "waiting" | "success" | "error";

// ─── component ──────────────────────────────────────────────────────────────

export default function GcmmoConnect() {
  const [method, setMethod]         = useState<Method>("choose");
  const [phase, setPhase]           = useState<Phase>("idle");
  const [phone, setPhone]           = useState("");
  const [token, setToken]           = useState("");
  const [showToken, setShowToken]   = useState(false);
  const [sessionId, setSessionId]   = useState("");
  const [savedToken, setSavedToken] = useState("");
  const [savedRefresh, setSavedRefresh] = useState("");
  const [error, setError]           = useState("");
  const [dots, setDots]             = useState(".");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Animate dots
  useEffect(() => {
    if (phase !== "waiting") return;
    const id = setInterval(() => setDots(d => d.length >= 3 ? "." : d + "."), 600);
    return () => clearInterval(id);
  }, [phase]);

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  function reset() {
    stopPoll();
    setMethod("choose");
    setPhase("idle");
    setPhone(""); setToken(""); setSessionId("");
    setSavedToken(""); setSavedRefresh(""); setError(""); setDots(".");
  }

  // ── Method 1: Auto (REST API — gọi thẳng Telegram OAuth) ─────────────────

  async function startAuto() {
    if (!phone.trim()) return;
    setPhase("loading");
    setError("");
    try {
      const r = await fetch(`${API}/gcmmo-auth/tg-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "Lỗi khởi động");
      setSessionId(d.sessionId);
      setPhase("waiting");
      startPollingBrowser(d.sessionId);
    } catch (e: any) {
      setError(e.message);
      setPhase("error");
    }
  }

  function startPollingBrowser(sid: string) {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${API}/gcmmo-auth/tg-poll/${sid}`);
        const d = await r.json();
        // ready: false → đang chờ user xác nhận
        if (d.ok && !d.ready) return;
        stopPoll();
        if (d.ok && d.ready) {
          setSavedToken(d.access_token ?? "");
          setSavedRefresh(d.refresh_token ?? "");
          setPhase("success");
        } else {
          setError(d.error ?? "Lỗi không xác định");
          setPhase("error");
        }
      } catch { /* network hiccup */ }
    }, POLL_MS);
  }

  // ── Method 2: Manual token paste ─────────────────────────────────────────

  async function saveManual() {
    const t = token.trim().replace(/^Bearer\s+/i, "");
    if (!t) return;
    setPhase("loading");
    setError("");
    try {
      const r = await fetch(`${API}/gcmmo-auth/save-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: t }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "Lỗi lưu token");
      setSavedToken(t);
      setPhase("success");
    } catch (e: any) {
      setError(e.message);
      setPhase("error");
    }
  }

  // ─── render ───────────────────────────────────────────────────────────────

  return (
    <div className="max-w-xl mx-auto space-y-6 py-2">
      <div>
        <h1 className="text-2xl font-bold">Kết nối gcmmo.net</h1>
        <p className="text-sm text-muted-foreground mt-1">Lấy token gcmmo.net để đồng bộ sản phẩm &amp; đơn hàng</p>
      </div>

      {/* ── SUCCESS ──────────────────────────────────────────────────────── */}
      {phase === "success" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-6 space-y-4">
            <div className="flex items-center gap-3 text-primary">
              <CheckCircle className="h-6 w-6" />
              <p className="text-lg font-semibold">Kết nối thành công!</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Token đã được load vào server. Để giữ sau khi restart, lưu vào{" "}
              <strong className="text-foreground">Replit Secrets</strong> với key{" "}
              <code className="bg-secondary px-1 rounded text-xs">GCMMO_ACCESS_TOKEN</code>.
            </p>
            {savedToken && <CopyRow label="GCMMO_ACCESS_TOKEN" value={savedToken} />}
            {savedRefresh && <CopyRow label="GCMMO_REFRESH_TOKEN" value={savedRefresh} />}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={reset} className="flex-1 gap-2">
              <RefreshCw className="h-4 w-4" /> Đổi token
            </Button>
            <Button className="flex-1" onClick={() => window.location.href = import.meta.env.BASE_URL + "sync"}>
              Đi tới Đồng bộ →
            </Button>
          </div>
        </div>
      )}

      {/* ── ERROR ────────────────────────────────────────────────────────── */}
      {phase === "error" && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 space-y-4">
          <div className="flex items-center gap-3 text-destructive">
            <TriangleAlert className="h-5 w-5" />
            <p className="font-semibold">Lỗi</p>
          </div>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={reset} className="gap-2">
            <RefreshCw className="h-4 w-4" /> Thử lại
          </Button>
        </div>
      )}

      {/* ── WAITING ──────────────────────────────────────────────────────── */}
      {phase === "waiting" && (
        <div className="rounded-xl border bg-card p-8 flex flex-col items-center gap-5 text-center">
          <div className="relative">
            <div className="h-20 w-20 rounded-full bg-[#2AABEE]/10 flex items-center justify-center">
              <svg className="h-10 w-10 text-[#2AABEE]" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.833.941z"/>
              </svg>
            </div>
            <div className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-primary animate-ping opacity-75" />
            <div className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-primary" />
          </div>
          <div>
            <p className="text-lg font-semibold">Đang chờ xác nhận{dots}</p>
            <p className="text-sm text-muted-foreground mt-1">
              Mở <strong>app Telegram</strong> → nhấn <strong>Allow / Xác nhận</strong>
            </p>
          </div>
          <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 w-full text-left text-xs text-muted-foreground">
            Headless browser đã mở gcmmo.net và nhập số điện thoại. Telegram sẽ gửi thông báo xác nhận đến app của bạn.
          </div>
          <button onClick={reset} className="text-xs text-muted-foreground hover:text-foreground">← Huỷ</button>
        </div>
      )}

      {/* ── CHOOSE METHOD ────────────────────────────────────────────────── */}
      {phase !== "success" && phase !== "error" && phase !== "waiting" && method === "choose" && (
        <div className="grid grid-cols-1 gap-4">
          {/* Method 1: Auto */}
          <button
            onClick={() => setMethod("auto")}
            className="rounded-xl border bg-card p-5 text-left hover:border-primary/50 hover:bg-primary/5 transition-all group"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="h-9 w-9 rounded-lg bg-[#2AABEE]/15 flex items-center justify-center">
                <Bot className="h-5 w-5 text-[#2AABEE]" />
              </div>
              <div>
                <p className="font-semibold group-hover:text-primary transition-colors">Tự động — Headless Browser</p>
                <p className="text-xs text-primary">Khuyên dùng</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Nhập SĐT Telegram → server mở browser ảo → bạn chỉ cần xác nhận trên app Telegram
            </p>
          </button>

          {/* Method 2: Manual */}
          <button
            onClick={() => setMethod("manual")}
            className="rounded-xl border bg-card p-5 text-left hover:border-primary/50 hover:bg-primary/5 transition-all group"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="h-9 w-9 rounded-lg bg-secondary flex items-center justify-center">
                <KeyRound className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-semibold group-hover:text-primary transition-colors">Thủ công — Dán token</p>
                <p className="text-xs text-muted-foreground">Dự phòng</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Tự đăng nhập gcmmo.net → copy Bearer token từ DevTools → dán vào đây
            </p>
          </button>
        </div>
      )}

      {/* ── AUTO FORM ────────────────────────────────────────────────────── */}
      {phase !== "success" && phase !== "error" && phase !== "waiting" && method === "auto" && (
        <div className="space-y-4">
          <button onClick={() => setMethod("choose")} className="text-xs text-muted-foreground hover:text-foreground">← Chọn phương thức khác</button>
          <div className="rounded-xl border bg-card p-5 space-y-5">
            <div>
              <p className="font-semibold mb-1">Đăng nhập Telegram tự động</p>
              <p className="text-sm text-muted-foreground">Server sẽ mở browser ảo, mở gcmmo.net và nhập SĐT thay bạn. Bạn chỉ cần xác nhận trên app Telegram.</p>
            </div>

            <div className="space-y-2">
              <Label>Số điện thoại Telegram</Label>
              <div className="flex gap-2">
                <Input
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && startAuto()}
                  placeholder="0988770961 hoặc +84988770961"
                  className="font-mono"
                  autoFocus
                  disabled={phase === "loading"}
                />
                <Button onClick={startAuto} disabled={phase === "loading" || !phone.trim()} className="gap-2 shrink-0">
                  {phase === "loading"
                    ? <RefreshCw className="h-4 w-4 animate-spin" />
                    : <Send className="h-4 w-4" />}
                  {phase === "loading" ? "Đang khởi động…" : "Bắt đầu"}
                </Button>
              </div>
            </div>

            <div className="rounded-lg bg-secondary/50 p-3 space-y-2 text-xs text-muted-foreground">
              <p className="font-semibold uppercase tracking-wide">Quy trình</p>
              <Step n={1} text="Server mở browser ảo (Chromium headless)" />
              <Step n={2} text="Browser vào gcmmo.net → click nút Telegram → nhập SĐT" />
              <Step n={3} text="Telegram gửi thông báo xác nhận về app của bạn" />
              <Step n={4} text="Bạn nhấn Allow → browser tự lấy token → xong!" />
            </div>
          </div>
        </div>
      )}

      {/* ── MANUAL FORM ──────────────────────────────────────────────────── */}
      {phase !== "success" && phase !== "error" && phase !== "waiting" && method === "manual" && (
        <div className="space-y-4">
          <button onClick={() => setMethod("choose")} className="text-xs text-muted-foreground hover:text-foreground">← Chọn phương thức khác</button>

          <div className="rounded-xl border bg-card p-5 space-y-4">
            <p className="font-semibold">Lấy token từ DevTools</p>
            <div className="space-y-2">
              <Step n={1} text='Mở gcmmo.net → đăng nhập (Telegram / Google / Email)' />
              <Step n={2} text='Sau khi vào được → nhấn F12 → tab Network → F5' />
              <Step n={3} text='Click vào request bất kỳ đến gcmmo.net → tìm header "Authorization"' />
              <Step n={4} text='Copy giá trị "Bearer eyJ..." → dán vào ô bên dưới' />
            </div>
            <a href="https://gcmmo.net/login" target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-primary hover:underline w-fit">
              Mở gcmmo.net <ExternalLink size={11} />
            </a>
          </div>

          <div className="rounded-xl border bg-card p-5 space-y-3">
            <Label>Access Token</Label>
            <div className="relative">
              <Input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={e => setToken(e.target.value)}
                onKeyDown={e => e.key === "Enter" && saveManual()}
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                className="font-mono text-xs pr-10"
                autoFocus
                disabled={phase === "loading"}
              />
              <button onClick={() => setShowToken(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">Có thể dán cả "Bearer eyJ..." — hệ thống tự bỏ phần "Bearer "</p>
            <Button onClick={saveManual} disabled={phase === "loading" || !token.trim()} className="w-full gap-2">
              {phase === "loading" ? <RefreshCw className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {phase === "loading" ? "Đang lưu…" : "Lưu token"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
