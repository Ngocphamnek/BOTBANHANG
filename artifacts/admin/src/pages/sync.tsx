import { useState, useEffect } from "react";
import { RefreshCw, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatVND } from "@/lib/utils";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";

interface SyncStatus {
  configured: boolean;
  message?: string;
  lastSync: string | null;
  lastResult?: any;
  balance?: { available: number; pending: number; currency: string } | null;
  balanceError?: string | null;
  summary?: any;
  profile?: any;
  error?: string;
}

interface SyncRunResult {
  ok?: boolean;
  products?: { ok: boolean; message: string; error?: string };
  orders?: { ok: boolean; message: string; error?: string };
  inventory?: { ok: boolean; message: string };
  balance?: { available: number; pending: number };
  timestamp?: string;
  message?: string;
}

function ResultRow({ label, result }: { label: string; result?: { ok: boolean; message: string; error?: string } }) {
  if (!result) return null;
  return (
    <div className="flex items-start gap-3 text-sm">
      {result.ok
        ? <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
        : <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />}
      <div>
        <span className="font-medium">{label}: </span>
        <span className="text-muted-foreground">{result.message}</span>
        {result.error && <p className="text-xs text-destructive mt-0.5">{result.error}</p>}
      </div>
    </div>
  );
}

export function SyncPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SyncRunResult | null>(null);

  async function fetchStatus() {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/sync/status`);
      setStatus(await r.json());
    } catch {
      setStatus({ configured: false, message: "Không thể kết nối tới API server", lastSync: null });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchStatus(); }, []);

  async function runSync(endpoint: string, label: string) {
    setSyncing(label);
    try {
      const r = await fetch(`${API_BASE}/${endpoint}`, { method: "POST" });
      const data = await r.json();
      setLastResult(data);
      await fetchStatus();
    } finally {
      setSyncing(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Đồng bộ gcmmo.net</h1>
        <p className="text-muted-foreground text-sm mt-1">Kết nối và đồng bộ dữ liệu từ api.gcmmo.net</p>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-4">
          <div className="h-32 rounded-xl border bg-card" />
          <div className="h-20 rounded-xl border bg-card" />
        </div>
      ) : status ? (
        <>
          {/* Connection status */}
          <div className="rounded-xl border bg-card p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className={`h-2.5 w-2.5 rounded-full ${status.configured ? "bg-primary animate-pulse" : "bg-destructive"}`} />
              <h2 className="font-semibold">
                {status.configured ? "Đã kết nối gcmmo.net" : "Chưa kết nối"}
              </h2>
              <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={fetchStatus}>
                <RefreshCw className="mr-1 h-3 w-3" /> Làm mới
              </Button>
            </div>

            {!status.configured && (
              <div className="flex items-start gap-3 text-sm rounded-lg bg-destructive/10 border border-destructive/20 p-4">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium text-destructive">Cần cấu hình token</p>
                  <p className="text-muted-foreground mt-1">{status.message}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Thêm <code className="bg-background px-1 rounded">GCMMO_ACCESS_TOKEN</code> vào Secrets của Replit.
                  </p>
                </div>
              </div>
            )}

            {status.configured && (
              <div className="grid grid-cols-2 gap-4 text-sm">
                {status.balance && (
                  <div className="rounded-lg bg-secondary/50 p-4">
                    <p className="text-xs text-muted-foreground">Số dư khả dụng</p>
                    <p className="text-xl font-bold text-primary mt-1">{formatVND(status.balance.available)}</p>
                    {status.balance.pending > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">Đang chờ: {formatVND(status.balance.pending)}</p>
                    )}
                  </div>
                )}
                {status.profile && (
                  <div className="rounded-lg bg-secondary/50 p-4">
                    <p className="text-xs text-muted-foreground">Tài khoản</p>
                    <p className="font-medium mt-1">{status.profile.shop_name ?? status.profile.name ?? "—"}</p>
                    {status.profile.email && <p className="text-xs text-muted-foreground">{status.profile.email}</p>}
                  </div>
                )}
                {status.lastSync && (
                  <div className="col-span-2 text-xs text-muted-foreground">
                    Lần đồng bộ gần nhất: {new Date(status.lastSync).toLocaleString("vi-VN")}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sync actions */}
          {status.configured && (
            <div className="rounded-xl border bg-card p-6 space-y-4">
              <h2 className="font-semibold text-sm">Đồng bộ thủ công</h2>
              <div className="grid grid-cols-2 gap-3">
                <Button onClick={() => runSync("sync", "Tất cả")} disabled={!!syncing}
                  className="bg-primary text-primary-foreground">
                  {syncing === "Tất cả" ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Đồng bộ tất cả
                </Button>
                <Button variant="outline" onClick={() => runSync("sync/products", "Sản phẩm")} disabled={!!syncing}>
                  {syncing === "Sản phẩm" ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Chỉ sản phẩm
                </Button>
                <Button variant="outline" onClick={() => runSync("sync/orders", "Đơn hàng")} disabled={!!syncing}>
                  {syncing === "Đơn hàng" ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Chỉ đơn hàng
                </Button>
                <Button variant="outline" onClick={() => runSync("sync/inventory", "Kho")} disabled={!!syncing}>
                  Chỉ kho hàng
                </Button>
              </div>
            </div>
          )}

          {/* Last sync result */}
          {lastResult && (
            <div className="rounded-xl border bg-card p-6 space-y-4">
              <h2 className="font-semibold text-sm">Kết quả đồng bộ vừa rồi</h2>
              <div className="space-y-3">
                {lastResult.products && <ResultRow label="Sản phẩm" result={lastResult.products} />}
                {lastResult.orders && <ResultRow label="Đơn hàng" result={lastResult.orders} />}
                {lastResult.inventory && <ResultRow label="Kho hàng" result={lastResult.inventory} />}
                {lastResult.message && (
                  <div className="text-sm text-muted-foreground">{lastResult.message}</div>
                )}
                {lastResult.timestamp && (
                  <p className="text-xs text-muted-foreground">{new Date(lastResult.timestamp).toLocaleString("vi-VN")}</p>
                )}
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
