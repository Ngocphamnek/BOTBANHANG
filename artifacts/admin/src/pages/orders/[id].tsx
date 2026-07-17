import { useParams, useLocation } from "wouter";
import { useGetOrder, useUpdateOrder, getListOrdersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatVND } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const STATUS_OPTIONS = [
  { value: "pending_payment", label: "Chờ thanh toán" },
  { value: "paid", label: "Đã thanh toán" },
  { value: "delivered", label: "Đã giao hàng" },
  { value: "cancelled", label: "Hủy đơn" },
] as const;

const STATUS_STYLE: Record<string, string> = {
  pending_payment: "bg-yellow-400/10 text-yellow-400",
  paid: "bg-blue-400/10 text-blue-400",
  delivered: "bg-primary/10 text-primary",
  cancelled: "bg-destructive/10 text-destructive",
};

export function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const numId = Number(id);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: order, isLoading } = useGetOrder(numId);
  const updateMutation = useUpdateOrder();

  if (isLoading) return <div className="animate-pulse h-64 rounded-xl border bg-card" />;
  if (!order) return <div className="text-muted-foreground">Không tìm thấy đơn hàng</div>;

  async function handleStatusChange(status: string) {
    await updateMutation.mutateAsync({ id: numId, data: { status: status as any } });
    qc.invalidateQueries({ queryKey: getListOrdersQueryKey() });
    toast({ title: "Đã cập nhật trạng thái đơn hàng" });
  }

  const deliveredItems: string[] = order.deliveredItems ? JSON.parse(order.deliveredItems) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/orders")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold">Đơn hàng #{order.id}</h1>
          <p className="text-xs text-muted-foreground">
            {new Date(order.createdAt).toLocaleString("vi-VN")}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className={`rounded px-2.5 py-1 text-sm font-medium ${STATUS_STYLE[order.status] ?? ""}`}>
            {STATUS_OPTIONS.find((s) => s.value === order.status)?.label ?? order.status}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <h2 className="font-semibold text-sm">Chi tiết đơn hàng</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Sản phẩm</dt>
              <dd className="font-medium">{order.productName ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Số lượng</dt>
              <dd className="font-medium">{order.quantity}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Tổng tiền</dt>
              <dd className="font-bold text-primary">{formatVND(order.totalPrice)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Phương thức TT</dt>
              <dd>{order.paymentMethod ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Telegram</dt>
              <dd>{order.telegramUsername ? `@${order.telegramUsername}` : `ID: ${order.telegramUserId}`}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border bg-card p-6 space-y-4">
          <h2 className="font-semibold text-sm">Cập nhật trạng thái</h2>
          <Select value={order.status} onValueChange={handleStatusChange} disabled={updateMutation.isPending}>
            <SelectTrigger className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border">
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Cập nhật cuối: {new Date(order.updatedAt).toLocaleString("vi-VN")}</p>
        </div>
      </div>

      {deliveredItems.length > 0 && (
        <div className="rounded-xl border bg-card p-6 space-y-3">
          <h2 className="font-semibold text-sm">Hàng đã giao</h2>
          <div className="space-y-1">
            {deliveredItems.map((item, i) => (
              <div key={i} className="font-mono text-xs bg-background rounded px-3 py-2 select-all">{item}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
