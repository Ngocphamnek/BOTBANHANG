import { useGetStats, useGetRevenueChart, useListRecentOrders } from "@workspace/api-client-react";
import { formatVND } from "@/lib/utils";
import { DollarSign, ShoppingCart, Package, Users, TrendingUp, Clock } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

function StatCard({ label, value, icon: Icon, sub }: { label: string; value: string | number; icon: React.ElementType; sub?: string }) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
          {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </div>
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pending_payment: { label: "Chờ TT", color: "text-yellow-400 bg-yellow-400/10" },
  paid: { label: "Đã TT", color: "text-blue-400 bg-blue-400/10" },
  delivered: { label: "Đã giao", color: "text-primary bg-primary/10" },
  cancelled: { label: "Hủy", color: "text-destructive bg-destructive/10" },
};

export function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetStats();
  const { data: chart } = useGetRevenueChart();
  const { data: recentOrders } = useListRecentOrders();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Tổng quan</h1>
        <p className="text-muted-foreground text-sm mt-1">Bảng điều khiển quản lý GC MMO Shop</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
        {statsLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-5 animate-pulse h-24" />
          ))
        ) : stats ? (
          <>
            <StatCard label="Doanh thu" value={formatVND(stats.totalRevenue)} icon={DollarSign} sub="Đơn đã giao" />
            <StatCard label="Đơn chờ TT" value={stats.pendingOrders} icon={Clock} sub="Cần xử lý" />
            <StatCard label="Đơn hôm nay" value={stats.todayOrders} icon={ShoppingCart} sub="Trong ngày" />
            <StatCard label="Sản phẩm" value={stats.totalProducts} icon={Package} sub="Đang hoạt động" />
            <StatCard label="Kho hàng" value={stats.totalInventory} icon={TrendingUp} sub="Còn lại" />
            <StatCard label="Khách hàng" value={stats.totalUsers} icon={Users} sub="Qua Telegram" />
          </>
        ) : null}
      </div>

      {/* Revenue chart */}
      {chart && chart.length > 0 && (
        <div className="rounded-xl border bg-card p-6">
          <h2 className="font-semibold mb-4">Doanh thu 30 ngày</h2>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chart} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(75,100%,65%)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(75,100%,65%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false}
                tickFormatter={(d) => d.slice(5)} interval={6} />
              <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false}
                tickFormatter={(v) => (v / 1000).toFixed(0) + "k"} />
              <Tooltip
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                formatter={(v: number) => [formatVND(v), "Doanh thu"]}
                labelStyle={{ color: "hsl(var(--muted-foreground))" }}
              />
              <Area type="monotone" dataKey="revenue" stroke="hsl(75,100%,65%)" strokeWidth={2} fill="url(#rev)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Recent orders */}
      {recentOrders && recentOrders.length > 0 && (
        <div className="rounded-xl border bg-card">
          <div className="flex items-center justify-between p-5 border-b">
            <h2 className="font-semibold">Đơn hàng gần đây</h2>
          </div>
          <div className="divide-y">
            {recentOrders.map((order) => {
              const s = STATUS_LABEL[order.status] ?? { label: order.status, color: "" };
              return (
                <div key={order.id} className="flex items-center justify-between px-5 py-3 text-sm">
                  <div className="flex items-center gap-4">
                    <span className="text-muted-foreground font-mono">#{order.id}</span>
                    <div>
                      <span className="font-medium">{order.productName ?? "—"}</span>
                      {order.telegramUsername && (
                        <span className="ml-2 text-xs text-muted-foreground">@{order.telegramUsername}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="font-medium">{formatVND(order.totalPrice)}</span>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.color}`}>{s.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
