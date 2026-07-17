import { useState, useEffect } from "react";
import {
  Bot, Send, Eye, EyeOff, CheckCircle2, XCircle, Loader2,
  RefreshCw, Link2, Zap, Wallet, Headphones, ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

interface BotStatus {
  running: boolean;
  username?: string;
  source: "env" | "db" | "none";
}

interface GcmmoStatus {
  configured: boolean;
  source: "env" | "db" | "none";
  lastSyncTime: string | null;
  lastSyncOk: boolean | null;
}

export function SettingsPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [gcmmoStatus, setGcmmoStatus] = useState<GcmmoStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Bot token
  const [botToken, setBotToken] = useState("");
  const [showBotToken, setShowBotToken] = useState(false);
  const [savingBotToken, setSavingBotToken] = useState(false);

  // GCMMO token
  const [gcmmoToken, setGcmmoToken] = useState("");
  const [showGcmmoToken, setShowGcmmoToken] = useState(false);
  const [savingGcmmoToken, setSavingGcmmoToken] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Channel ID
  const [channelId, setChannelId] = useState("");
  const [savingChannel, setSavingChannel] = useState(false);

  // Bank / top-up settings
  const [bankName, setBankName] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankHolder, setBankHolder] = useState("");
  const [minTopup, setMinTopup] = useState("");
  const [savingBank, setSavingBank] = useState(false);

  // Support settings
  const [supportContact, setSupportContact] = useState("");
  const [supportNote, setSupportNote] = useState("");
  const [savingSupport, setSavingSupport] = useState(false);

  // Quality filter settings
  const [minSellerReviews, setMinSellerReviews] = useState("");
  const [minSellerRating, setMinSellerRating] = useState("");
  const [minSellerSold, setMinSellerSold] = useState("");
  const [savingQuality, setSavingQuality] = useState(false);

  async function fetchData() {
    setLoading(true);
    try {
      const [sRes, bRes, gRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/settings/bot-status"),
        fetch("/api/settings/gcmmo-status"),
      ]);
      const s = await sRes.json();
      const b = await bRes.json();
      const g = await gRes.json();
      setSettings(s);
      setBotStatus(b);
      setGcmmoStatus(g);
      setChannelId(s.channelId ?? "");
      setBankName(s.bank_name ?? "");
      setBankAccount(s.bank_account ?? "");
      setBankHolder(s.bank_holder ?? "");
      setMinTopup(s.min_topup ?? "10000");
      setSupportContact(s.support_contact ?? "");
      setSupportNote(s.support_note ?? "");
      setMinSellerReviews(s.min_seller_reviews ?? "0");
      setMinSellerRating(s.min_seller_rating ?? "0");
      setMinSellerSold(s.min_seller_sold ?? "0");
    } catch {
      toast({ title: "Lỗi tải settings", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  async function saveSetting(key: string, value: string) {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? "Lỗi lưu setting");
    }
  }

  async function handleSaveBotToken() {
    if (!botToken.trim()) return;
    setSavingBotToken(true);
    try {
      await saveSetting("botToken", botToken.trim());
      setBotToken("");
      toast({ title: "Đã lưu token — đang khởi động bot..." });
      await new Promise(r => setTimeout(r, 2500));
      await fetchData();
      toast({ title: "Bot đã được cấu hình!" });
    } catch (e) {
      toast({ title: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingBotToken(false);
    }
  }

  async function handleSaveGcmmoToken() {
    const token = gcmmoToken.trim().replace(/^Bearer\s+/i, "");
    if (!token) return;
    setSavingGcmmoToken(true);
    try {
      await saveSetting("gcmmoAccessToken", token);
      setGcmmoToken("");
      toast({ title: "✅ Đã lưu token GCMMO — đang đồng bộ..." });
      await new Promise(r => setTimeout(r, 1500));
      await fetchData();
      toast({ title: "Token đã được cấu hình! Đồng bộ đang chạy nền." });
    } catch (e) {
      toast({ title: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingGcmmoToken(false);
    }
  }

  async function handleManualSync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync/all", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "Lỗi đồng bộ");
      toast({
        title: "✅ Đồng bộ hoàn tất",
        description: `Sản phẩm: ${data.products?.message} · Đơn hàng: ${data.orders?.message}`,
      });
      await fetchData();
    } catch (e) {
      toast({ title: (e as Error).message, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveChannel() {
    setSavingChannel(true);
    try {
      await saveSetting("channelId", channelId.trim());
      toast({ title: "Đã lưu Channel ID" });
      await fetchData();
    } catch (e) {
      toast({ title: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingChannel(false);
    }
  }

  async function handleSaveBank() {
    setSavingBank(true);
    try {
      await Promise.all([
        saveSetting("bank_name", bankName.trim()),
        saveSetting("bank_account", bankAccount.trim()),
        saveSetting("bank_holder", bankHolder.trim()),
        saveSetting("min_topup", minTopup.trim() || "10000"),
      ]);
      toast({ title: "✅ Đã lưu thông tin ngân hàng" });
    } catch (e) {
      toast({ title: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingBank(false);
    }
  }

  async function handleSaveSupport() {
    setSavingSupport(true);
    try {
      await Promise.all([
        saveSetting("support_contact", supportContact.trim()),
        saveSetting("support_note", supportNote.trim()),
      ]);
      toast({ title: "✅ Đã lưu thông tin hỗ trợ" });
    } catch (e) {
      toast({ title: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingSupport(false);
    }
  }

  async function handleSaveQuality() {
    setSavingQuality(true);
    try {
      await Promise.all([
        saveSetting("min_seller_reviews", minSellerReviews.trim() || "0"),
        saveSetting("min_seller_rating", minSellerRating.trim() || "0"),
        saveSetting("min_seller_sold", minSellerSold.trim() || "0"),
      ]);
      toast({ title: "✅ Đã lưu bộ lọc chất lượng shop" });
    } catch (e) {
      toast({ title: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingQuality(false);
    }
  }

  const botTokenIsSet = settings._envBotToken === "SET" || settings.botToken === "SET";
  const gcmmoTokenIsSet = settings._envGcmmoToken === "SET" || settings.gcmmoAccessToken === "SET";

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Cài đặt</h1>
        <p className="text-sm text-muted-foreground mt-1">Cấu hình Telegram Bot và kết nối GCMMO</p>
      </div>

      {/* ── Trạng thái tổng quan ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4">
        {/* Bot status */}
        <div className="rounded-xl border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Telegram Bot</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={fetchData} disabled={loading}>
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
          {botStatus ? (
            <div className="flex items-center gap-2">
              {botStatus.running
                ? <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                : <XCircle className="h-4 w-4 text-destructive shrink-0" />}
              <div>
                <p className={`text-sm font-medium ${botStatus.running ? "text-primary" : "text-destructive"}`}>
                  {botStatus.running ? "Đang hoạt động" : "Chưa kết nối"}
                </p>
                {botStatus.username && <p className="text-xs text-muted-foreground">@{botStatus.username}</p>}
              </div>
            </div>
          ) : <div className="h-8 bg-secondary/50 rounded animate-pulse" />}
        </div>

        {/* GCMMO status */}
        <div className="rounded-xl border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">GCMMO</span>
            {gcmmoStatus?.configured && (
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleManualSync} disabled={syncing}>
                <Zap className={`h-3 w-3 text-primary ${syncing ? "animate-pulse" : ""}`} />
              </Button>
            )}
          </div>
          {gcmmoStatus ? (
            <div className="flex items-center gap-2">
              {gcmmoStatus.configured
                ? <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                : <XCircle className="h-4 w-4 text-destructive shrink-0" />}
              <div>
                <p className={`text-sm font-medium ${gcmmoStatus.configured ? "text-primary" : "text-destructive"}`}>
                  {gcmmoStatus.configured ? "Đã kết nối" : "Chưa cấu hình"}
                </p>
                {gcmmoStatus.lastSyncTime && (
                  <p className="text-xs text-muted-foreground">
                    Sync: {new Date(gcmmoStatus.lastSyncTime).toLocaleTimeString("vi-VN")}
                    {" · "}{gcmmoStatus.source}
                  </p>
                )}
              </div>
            </div>
          ) : <div className="h-8 bg-secondary/50 rounded animate-pulse" />}
        </div>
      </div>

      {/* ── GCMMO Access Token ───────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <Link2 className="h-4 w-4" />
            GCMMO Access Token
          </h2>
          {gcmmoStatus?.configured && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleManualSync}
              disabled={syncing}
              className="text-primary border-primary/30 hover:bg-primary/10"
            >
              {syncing
                ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Đang sync...</>
                : <><Zap className="h-3.5 w-3.5 mr-1.5" />Đồng bộ ngay</>}
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Token Bearer từ gcmmo.net — dùng để đồng bộ sản phẩm và đơn hàng tự động.
          Hoặc vào <a href="/gcmmo-connect" className="text-primary underline">Kết nối gcmmo</a> để đăng nhập qua Telegram.
        </p>

        <div className="space-y-2">
          <Label className="text-xs">
            {gcmmoTokenIsSet ? "Nhập token mới để thay thế" : "Access Token"}
          </Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showGcmmoToken ? "text" : "password"}
                value={gcmmoToken}
                onChange={(e) => setGcmmoToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSaveGcmmoToken()}
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                className="bg-background pr-10 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => setShowGcmmoToken(!showGcmmoToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showGcmmoToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button
              onClick={handleSaveGcmmoToken}
              disabled={savingGcmmoToken || !gcmmoToken.trim()}
              className="bg-primary text-primary-foreground shrink-0"
            >
              {savingGcmmoToken
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : "Lưu & Đồng bộ"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Có thể dán cả "Bearer eyJ..." — hệ thống tự cắt phần "Bearer "</p>
          {gcmmoTokenIsSet && (
            <p className="text-xs text-primary flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Token đang được cấu hình
              {settings._envGcmmoToken === "SET" ? " (từ biến môi trường)" : " (từ cài đặt DB)"}
            </p>
          )}
        </div>
      </div>

      {/* ── Telegram Bot Token ───────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <h2 className="font-semibold flex items-center gap-2">
          <Bot className="h-4 w-4" />
          Telegram Bot Token
        </h2>
        <p className="text-xs text-muted-foreground">
          Lấy token từ <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-primary underline">@BotFather</a>.
          {botTokenIsSet && " Token hiện tại đang được cấu hình."}
        </p>
        <div className="space-y-2">
          <Label className="text-xs">
            {botTokenIsSet ? "Nhập token mới để thay thế" : "Bot Token"}
          </Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showBotToken ? "text" : "password"}
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSaveBotToken()}
                placeholder="123456789:ABC-DEF..."
                className="bg-background pr-10 font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShowBotToken(!showBotToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showBotToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button
              onClick={handleSaveBotToken}
              disabled={savingBotToken || !botToken.trim()}
              className="bg-primary text-primary-foreground shrink-0"
            >
              {savingBotToken ? <Loader2 className="h-4 w-4 animate-spin" /> : "Lưu & Khởi động"}
            </Button>
          </div>
          {botTokenIsSet && (
            <p className="text-xs text-primary flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Token đã được cấu hình
              {settings._envBotToken === "SET" ? " (từ biến môi trường)" : " (từ cài đặt DB)"}
            </p>
          )}
        </div>
      </div>

      {/* ── Thông tin nạp tiền (ngân hàng) ──────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <h2 className="font-semibold flex items-center gap-2">
          <Wallet className="h-4 w-4" />
          Thông tin nạp tiền (hiển thị cho user trong bot)
        </h2>
        <p className="text-xs text-muted-foreground">
          Khi user nhấn "Nạp tiền" trong bot, thông tin này sẽ được hiển thị để họ chuyển khoản.
          Sau khi nhận tiền, vào <a href="/wallet" className="text-primary underline">Quản lý ví</a> để xác nhận.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Tên ngân hàng</Label>
            <Input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Vietcombank, MB Bank..." />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Số tài khoản</Label>
            <Input value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} placeholder="0123456789" className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Chủ tài khoản</Label>
            <Input value={bankHolder} onChange={(e) => setBankHolder(e.target.value)} placeholder="NGUYEN VAN A" className="uppercase" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Nạp tối thiểu (VNĐ)</Label>
            <Input type="number" value={minTopup} onChange={(e) => setMinTopup(e.target.value)} placeholder="10000" />
          </div>
        </div>
        <Button onClick={handleSaveBank} disabled={savingBank} variant="outline">
          {savingBank ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Lưu thông tin ngân hàng
        </Button>
      </div>

      {/* ── Hỗ trợ khách hàng ───────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <h2 className="font-semibold flex items-center gap-2">
          <Headphones className="h-4 w-4" />
          Hỗ trợ khách hàng
        </h2>
        <p className="text-xs text-muted-foreground">
          Thông tin hiển thị khi user nhấn "Hỗ trợ" trong bot.
        </p>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Liên hệ hỗ trợ (username/link)</Label>
            <Input value={supportContact} onChange={(e) => setSupportContact(e.target.value)} placeholder="@admin hoặc t.me/admin" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Ghi chú hỗ trợ</Label>
            <Input value={supportNote} onChange={(e) => setSupportNote(e.target.value)} placeholder="Liên hệ admin để được hỗ trợ nhanh nhất..." />
          </div>
        </div>
        <Button onClick={handleSaveSupport} disabled={savingSupport} variant="outline">
          {savingSupport ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Lưu thông tin hỗ trợ
        </Button>
      </div>

      {/* ── Kênh phát sóng ──────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <h2 className="font-semibold flex items-center gap-2">
          <Send className="h-4 w-4" />
          Kênh phát sóng sản phẩm
        </h2>
        <p className="text-xs text-muted-foreground">
          Chat ID của kênh/nhóm Telegram khi nhấn "Gửi lên Telegram" trên trang sản phẩm.
          Ví dụ: <code className="bg-secondary px-1 rounded">-1001234567890</code> hoặc <code className="bg-secondary px-1 rounded">@tenkenh</code>
        </p>
        <div className="space-y-2">
          <Label className="text-xs">Channel ID / Username kênh</Label>
          <div className="flex gap-2">
            <Input
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              placeholder="-1001234567890 hoặc @tenkenh"
              className="bg-background font-mono text-sm"
            />
            <Button onClick={handleSaveChannel} disabled={savingChannel} variant="outline">
              {savingChannel ? <Loader2 className="h-4 w-4 animate-spin" /> : "Lưu"}
            </Button>
          </div>
        </div>
      </div>

      {/* ── Lọc chất lượng shop ─────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <h2 className="font-semibold flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Lọc chất lượng shop (Bot Telegram)
        </h2>
        <p className="text-xs text-muted-foreground">
          Sản phẩm của shop <strong>không đạt</strong> ngưỡng bên dưới sẽ <strong>bị ẩn</strong> trên bot Telegram.
          Đặt 0 để tắt điều kiện đó. Áp dụng ngay, không cần khởi động lại.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Lượt đánh giá tối thiểu</Label>
            <Input
              type="number"
              min={0}
              value={minSellerReviews}
              onChange={(e) => setMinSellerReviews(e.target.value)}
              placeholder="0 = không lọc"
              className="bg-background"
            />
            <p className="text-xs text-muted-foreground">Shop dưới X lượt review → ẩn</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Rating tối thiểu (0–50)</Label>
            <Input
              type="number"
              min={0}
              max={50}
              value={minSellerRating}
              onChange={(e) => setMinSellerRating(e.target.value)}
              placeholder="0 = không lọc"
              className="bg-background"
            />
            <p className="text-xs text-muted-foreground">Nhập rating×10: 4.0 sao → 40</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Đơn hoàn thành tối thiểu</Label>
            <Input
              type="number"
              min={0}
              value={minSellerSold}
              onChange={(e) => setMinSellerSold(e.target.value)}
              placeholder="0 = không lọc"
              className="bg-background"
            />
            <p className="text-xs text-muted-foreground">Shop bán dưới X đơn → ẩn</p>
          </div>
        </div>
        <div className="flex items-center gap-3 pt-1">
          <Button onClick={handleSaveQuality} disabled={savingQuality} variant="outline">
            {savingQuality ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Lưu bộ lọc
          </Button>
          {(Number(minSellerReviews) > 0 || Number(minSellerRating) > 0 || Number(minSellerSold) > 0) && (
            <span className="text-xs text-amber-400 flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" />
              Đang lọc: shop cần ≥{minSellerReviews} đánh giá
              {Number(minSellerRating) > 0 && `, ≥${(Number(minSellerRating)/10).toFixed(1)}⭐`}
              {Number(minSellerSold) > 0 && `, ≥${minSellerSold} đơn`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
