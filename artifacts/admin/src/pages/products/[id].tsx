import { useState } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetProduct, useUpdateProduct, useDeleteProduct,
  useGetProductInventory, useAddInventoryItems, useDeleteInventoryItem,
  getListProductsQueryKey, getGetProductQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { formatVND } from "@/lib/utils";
import {
  ArrowLeft, Trash2, Plus, Send, Loader2, Image,
  ExternalLink, TrendingUp, Package, RefreshCw, AlertCircle, Wifi,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// Live stock từ gcmmo.net (gọi thẳng API, không qua cache DB)
function useGcmmoLiveStock(localProductId: number, enabled: boolean) {
  return useQuery<{ stock: number; status: string; price: number; sold_count?: number }>({
    queryKey: ["gcmmo-live-stock", localProductId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/products/${localProductId}/gcmmo-live`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as any).error ?? "Lỗi lấy stock gcmmo");
      }
      return res.json();
    },
    enabled,
    staleTime: 0,       // luôn fetch mới khi mount
    refetchOnMount: true,
    retry: 1,
  });
}

export function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const numId = Number(id);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: product, isLoading } = useGetProduct(numId);
  const { data: inventory } = useGetProductInventory(numId);
  const updateMutation = useUpdateProduct();
  const deleteMutation = useDeleteProduct();
  const addItemsMutation = useAddInventoryItems();
  const deleteItemMutation = useDeleteInventoryItem();

  const isGcmmoProduct = !!(product as any)?.sourceId;
  const liveStock = useGcmmoLiveStock(numId, isGcmmoProduct);

  const [form, setForm] = useState<{
    price: string; isActive: boolean;
    name: string; category: string; description: string; imageUrl: string;
  } | null>(null);
  const [newItems, setNewItems] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastChatId, setBroadcastChatId] = useState("");
  const [showBroadcastInput, setShowBroadcastInput] = useState(false);

  if (isLoading) return <div className="animate-pulse h-64 rounded-xl border bg-card" />;
  if (!product) return <div>Không tìm thấy sản phẩm</div>;

  const p = product as typeof product & {
    gcmmoPrice?: number | null;
    stock?: number | null;
    sourceId?: string | null;
    gcmmoVariantId?: string | null;
    gcmmoSellerId?: string | null;
    imageUrl?: string | null;
  };

  const isGcmmo = !!p.sourceId;
  const gcmmoPrice = p.gcmmoPrice ?? 0;
  const stock = p.stock ?? 0;

  const f = form ?? {
    price: String(product.price),
    isActive: product.isActive,
    name: product.name,
    category: p.category ?? "",
    description: p.description ?? "",
    imageUrl: p.imageUrl ?? "",
  };

  const profit = gcmmoPrice > 0 ? Number(f.price) - gcmmoPrice : null;
  const profitPct = profit && gcmmoPrice > 0 ? ((profit / gcmmoPrice) * 100).toFixed(1) : null;

  async function handleSave() {
    await updateMutation.mutateAsync({
      id: numId,
      data: {
        price: Number(f.price),
        isActive: f.isActive,
        name: f.name,
        category: f.category || undefined,
        description: f.description || undefined,
        imageUrl: f.imageUrl || undefined,
      },
    });
    qc.invalidateQueries({ queryKey: getGetProductQueryKey(numId) });
    qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
    toast({ title: "Đã cập nhật sản phẩm" });
    setForm(null);
  }

  async function handleDelete() {
    await deleteMutation.mutateAsync({ id: numId });
    qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
    navigate("/products");
    toast({ title: "Đã xóa sản phẩm" });
  }

  async function handleAddItems() {
    const items = newItems.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    await addItemsMutation.mutateAsync({ id: numId, data: { items } });
    qc.invalidateQueries({ queryKey: getGetProductQueryKey(numId) });
    qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
    setNewItems("");
    toast({ title: `Đã thêm ${items.length} hàng vào kho` });
  }

  async function handleDeleteItem(itemId: number) {
    await deleteItemMutation.mutateAsync({ id: itemId });
    qc.invalidateQueries({ queryKey: getGetProductQueryKey(numId) });
    qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
  }

  async function handleBroadcast() {
    setBroadcasting(true);
    try {
      const res = await fetch(`/api/products/${numId}/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: broadcastChatId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Lỗi không xác định");
      toast({ title: "✅ Đã gửi sản phẩm lên Telegram!" });
      setShowBroadcastInput(false);
      setBroadcastChatId("");
    } catch (err) {
      toast({ title: (err as Error).message, variant: "destructive" });
    } finally {
      setBroadcasting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="icon" onClick={() => navigate("/products")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold truncate">{product.name}</h1>
            {isGcmmo && (
              <Badge variant="secondary" className="text-primary border-primary/30 flex-shrink-0">
                gcmmo
              </Badge>
            )}
            {!product.isActive && (
              <Badge variant="destructive" className="flex-shrink-0">Đang ẩn</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">ID #{product.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline" size="sm"
            className="text-blue-400 border-blue-400/30 hover:bg-blue-400/10"
            onClick={() => setShowBroadcastInput(!showBroadcastInput)}
          >
            <Send className="mr-1.5 h-3.5 w-3.5" /> Gửi Telegram
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:bg-destructive/10">
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Xóa
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="bg-card border text-foreground">
              <AlertDialogHeader>
                <AlertDialogTitle>Xóa sản phẩm?</AlertDialogTitle>
                <AlertDialogDescription>Hành động này không thể hoàn tác.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Hủy</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete} className="bg-destructive text-white">Xóa</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending} className="bg-primary text-primary-foreground">
            {updateMutation.isPending ? "Đang lưu..." : "Lưu thay đổi"}
          </Button>
        </div>
      </div>

      {/* Broadcast panel */}
      {showBroadcastInput && (
        <div className="rounded-xl border border-blue-400/30 bg-blue-400/5 p-4 space-y-3">
          <p className="text-sm font-medium text-blue-400 flex items-center gap-2">
            <Send className="h-4 w-4" /> Gửi sản phẩm lên Telegram
          </p>
          <div className="flex gap-2">
            <Input
              value={broadcastChatId}
              onChange={(e) => setBroadcastChatId(e.target.value)}
              placeholder="Chat ID / @username (để trống = dùng mặc định)"
              className="bg-background font-mono text-sm flex-1"
            />
            <Button onClick={handleBroadcast} disabled={broadcasting} className="bg-blue-500 hover:bg-blue-600 text-white">
              {broadcasting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Gửi ngay"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowBroadcastInput(false)}>Hủy</Button>
          </div>
        </div>
      )}

      {/* Main grid */}
      <div className="grid grid-cols-2 gap-6">
        {/* Left: Product info */}
        <div className="space-y-4">
          {/* Thumbnail */}
          {(f.imageUrl || p.imageUrl) && (
            <div className="rounded-xl border bg-card overflow-hidden">
              <img
                src={f.imageUrl || p.imageUrl || ""}
                alt={product.name}
                className="w-full h-48 object-cover"
                onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = "none"; }}
              />
            </div>
          )}

          {/* gcmmo info card (read-only for gcmmo products) */}
          {isGcmmo && (
            <div className="rounded-xl border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm flex items-center gap-2">
                  <ExternalLink className="h-4 w-4 text-primary" />
                  Thông tin gcmmo.net
                </h2>
                <a
                  href={`https://gcmmo.net/products/${p.sourceId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  Xem trên gcmmo <ExternalLink className="h-3 w-3" />
                </a>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg bg-secondary/50 p-3">
                  <p className="text-xs text-muted-foreground">Giá gốc gcmmo</p>
                  <p className="font-semibold mt-0.5">{gcmmoPrice > 0 ? formatVND(gcmmoPrice) : "—"}</p>
                </div>
                <div className="rounded-lg bg-secondary/50 p-3">
                  <p className="text-xs text-muted-foreground">Tồn kho gcmmo</p>
                  <p className={`font-semibold mt-0.5 ${stock > 0 ? "text-green-400" : "text-destructive"}`}>
                    {stock > 0 ? stock : "Hết hàng"}
                  </p>
                </div>
              </div>

              {p.gcmmoVariantId && (
                <p className="text-xs text-muted-foreground">
                  Variant ID: <span className="font-mono text-foreground">{p.gcmmoVariantId}</span>
                </p>
              )}
            </div>
          )}

          {/* Editable info */}
          <div className="rounded-xl border bg-card p-4 space-y-3">
            <h2 className="font-semibold text-sm">Thông tin sản phẩm</h2>

            {!isGcmmo && (
              <>
                <div>
                  <Label className="text-xs">Tên sản phẩm</Label>
                  <Input value={f.name} onChange={(e) => setForm({ ...f, name: e.target.value })} className="mt-1 bg-background text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Danh mục</Label>
                  <Input value={f.category} onChange={(e) => setForm({ ...f, category: e.target.value })} className="mt-1 bg-background text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Mô tả</Label>
                  <Input value={f.description} onChange={(e) => setForm({ ...f, description: e.target.value })} className="mt-1 bg-background text-sm" />
                </div>
                <div>
                  <Label className="text-xs flex items-center gap-1"><Image className="h-3 w-3" /> URL ảnh</Label>
                  <Input value={f.imageUrl} onChange={(e) => setForm({ ...f, imageUrl: e.target.value })} placeholder="https://..." className="mt-1 bg-background text-sm font-mono" />
                </div>
              </>
            )}

            {isGcmmo && (
              <div className="rounded-lg bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
                ℹ️ Tên, mô tả, ảnh lấy trực tiếp từ gcmmo.net — cập nhật tự động khi đồng bộ
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <Label className="text-xs">Hiển thị trên bot</Label>
              <Switch checked={f.isActive} onCheckedChange={(v) => setForm({ ...f, isActive: v })} />
            </div>
          </div>
        </div>

        {/* Right: Pricing + inventory */}
        <div className="space-y-4">
          {/* Markup pricing */}
          <div className="rounded-xl border bg-card p-4 space-y-4">
            <h2 className="font-semibold text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              {isGcmmo ? "Giá bán (Markup)" : "Giá bán"}
            </h2>

            {isGcmmo && gcmmoPrice > 0 && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground text-xs">Giá vốn gcmmo</span>
                  <span className="font-medium">{formatVND(gcmmoPrice)}</span>
                </div>
                <div className="flex justify-between items-center mt-1">
                  <span className="text-muted-foreground text-xs">Giá bán của bạn</span>
                  <span className="font-semibold text-foreground">{formatVND(Number(f.price))}</span>
                </div>
                {profit !== null && (
                  <div className="flex justify-between items-center mt-1 pt-1 border-t border-primary/10">
                    <span className="text-xs font-medium">Lợi nhuận</span>
                    <span className={`font-bold text-sm ${profit > 0 ? "text-green-400" : "text-destructive"}`}>
                      {profit > 0 ? "+" : ""}{formatVND(profit)} ({profitPct}%)
                    </span>
                  </div>
                )}
              </div>
            )}

            <div>
              <Label className="text-xs">Giá bán ra (VNĐ)</Label>
              <Input
                type="number"
                value={f.price}
                onChange={(e) => setForm({ ...f, price: e.target.value })}
                className="mt-1 bg-background text-sm font-mono"
              />
            </div>

            {isGcmmo && gcmmoPrice > 0 && (
              <div className="flex gap-2 flex-wrap">
                {[10, 20, 30, 50].map((pct) => (
                  <Button
                    key={pct}
                    variant="outline"
                    size="sm"
                    className="text-xs h-7 px-2"
                    onClick={() => setForm({ ...f, price: String(Math.round(gcmmoPrice * (1 + pct / 100))) })}
                  >
                    +{pct}%
                  </Button>
                ))}
              </div>
            )}
          </div>

          {/* Inventory section */}
          {isGcmmo ? (
            <div className="rounded-xl border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm flex items-center gap-2">
                  <Wifi className="h-4 w-4 text-primary" />
                  Kho hàng thực tế (gcmmo.net)
                </h2>
                <Button
                  variant="ghost" size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => qc.invalidateQueries({ queryKey: ["gcmmo-live-stock", numId] })}
                  disabled={liveStock.isFetching}
                >
                  <RefreshCw className={`h-3.5 w-3.5 mr-1 ${liveStock.isFetching ? "animate-spin" : ""}`} />
                  Làm mới
                </Button>
              </div>

              {liveStock.isLoading || liveStock.isFetching ? (
                <div className="rounded-lg bg-secondary/30 p-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Đang lấy kho từ gcmmo.net...
                </div>
              ) : liveStock.isError ? (
                <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs text-destructive font-medium">Không lấy được kho live</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{(liveStock.error as Error).message}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Kho cache DB: <span className="font-medium text-foreground">{stock}</span>
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="rounded-lg bg-secondary/30 p-4 text-center relative">
                    <div className="absolute top-2 right-2">
                      <span className="flex items-center gap-1 text-xs text-green-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse inline-block" />
                        Live
                      </span>
                    </div>
                    <p className={`text-4xl font-bold ${(liveStock.data?.stock ?? 0) > 0 ? "text-green-400" : "text-destructive"}`}>
                      {liveStock.data?.stock ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Sản phẩm còn lại trên gcmmo.net</p>
                    {liveStock.data?.sold_count !== undefined && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Đã bán tổng: <span className="font-medium text-foreground">{liveStock.data.sold_count}</span>
                      </p>
                    )}
                  </div>
                  <div className="rounded-lg bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
                    🔄 Bot tự mua từ gcmmo khi có đơn — không cần nhập kho thủ công
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="rounded-xl border bg-card p-4 space-y-3">
              <h2 className="font-semibold text-sm">Thêm hàng vào kho</h2>
              <p className="text-xs text-muted-foreground">Mỗi dòng là một tài khoản / key</p>
              <Textarea
                value={newItems}
                onChange={(e) => setNewItems(e.target.value)}
                placeholder={"username:password\nkey1234\n..."}
                className="bg-background font-mono text-xs min-h-[120px]"
              />
              <Button size="sm" onClick={handleAddItems} disabled={addItemsMutation.isPending || !newItems.trim()}
                className="bg-primary text-primary-foreground w-full">
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {addItemsMutation.isPending ? "Đang thêm..." : "Thêm vào kho"}
              </Button>
            </div>
          )}

          {/* Local inventory list (only for non-gcmmo or if has local items) */}
          {!isGcmmo && inventory && (
            <div className="rounded-xl border bg-card">
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <h2 className="font-semibold text-sm">Kho hàng</h2>
                <span className="text-xs text-muted-foreground">
                  {inventory.filter((i) => i.status === "available").length} còn lại
                </span>
              </div>
              <div className="divide-y max-h-64 overflow-y-auto">
                {inventory.length === 0 ? (
                  <p className="text-sm text-muted-foreground px-4 py-4">Chưa có hàng trong kho.</p>
                ) : inventory.map((item) => (
                  <div key={item.id} className="flex items-center justify-between px-4 py-2.5 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`rounded px-1.5 py-0.5 font-medium flex-shrink-0 ${
                        item.status === "available" ? "bg-primary/10 text-primary" :
                        item.status === "sold" ? "bg-muted text-muted-foreground" : "bg-blue-400/10 text-blue-400"
                      }`}>{item.status}</span>
                      <span className="font-mono text-foreground truncate">{item.content}</span>
                    </div>
                    {item.status === "available" && (
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive flex-shrink-0"
                        onClick={() => handleDeleteItem(item.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
