import { useState } from "react";
import { Link } from "wouter";
import { useListOrders } from "@workspace/api-client-react";
import { formatVND } from "@/lib/utils";
import { ChevronRight, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";

const STATUSES = [
  { value: "", label: "Tất cả" },
  { value: "pending_payment", label: "Chờ TT" },
  { value: "paid", label: "Đã TT" },
  { value: "delivered", label: "Đã giao" },
  { value: "cancelled", label: "Hủy" },
];

const STATUS_STYLE: Record<string, string> = {
  pending_payment: "bg-yellow-400/10 text-yellow-400",
  paid: "bg-blue-400/10 text-blue-400",
  delivered: "bg-primary/10 text-primary",
  cancelled: "bg-destructive/10 text-destructive",
};

export function OrdersPage() {
  const [status, setStatus] = useState("");
  const { data: orders, isLoading } = useListOrders(status ? { status } : {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Đơn hàng</h1>
        <p className="text-muted-foreground text-sm mt-1">{orders?.length ?? 0} đơn hàng</p>
      </div>

      <div className="flex gap-2">
        {STATUSES.map((s) => (
          <Button
            key={s.value}
            variant={status === s.value ? "default" : "outline"}
            size="sm"
            onClick={() => setStatus(s.value)}
            className={status === s.value ? "bg-primary text-primary-foreground" : ""}
          >
            {s.label}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card h-16 animate-pulse" />
          ))}
        </div>
      ) : orders && orders.length > 0 ? (
        <div className="rounded-xl border bg-card divide-y">
          {orders.map((order) => (
            <Link key={order.id} href={`/orders/${order.id}`}
              className="flex items-center justify-between px-5 py-4 hover:bg-secondary/50 transition-colors cursor-pointer">
              <div className="flex items-center gap-4">
                <div className="rounded-lg bg-secondary p-2 text-muted-foreground">
                  <ShoppingCart className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-muted-foreground">#{order.id}</span>
                    <span className="font-medium text-sm">{order.productName ?? "—"}</span>
                  </div>
                  {order.telegramUsername && (
                    <p className="text-xs text-muted-foreground mt-0.5">@{order.telegramUsername}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className="font-medium text-sm">{formatVND(order.totalPrice)}</span>
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[order.status] ?? ""}`}>
                  {STATUSES.find((s) => s.value === order.status)?.label ?? order.status}
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border bg-card flex flex-col items-center justify-center py-16 text-center">
          <ShoppingCart className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-muted-foreground">Chưa có đơn hàng nào.</p>
        </div>
      )}
    </div>
  );
}
