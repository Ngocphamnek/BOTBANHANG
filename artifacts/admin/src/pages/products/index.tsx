import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useListProducts } from "@workspace/api-client-react";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { getListProductsQueryKey } from "@workspace/api-client-react";
import { formatVND } from "@/lib/utils";
import {
  Plus, Package, ChevronRight, RefreshCw, Download,
  TrendingUp, Search, Filter, CheckSquare, Square, X,
  ExternalLink, Loader2, AlertCircle, ShoppingCart,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

// ── Types ─────────────────────────────────────────────────────────────────────
interface GcmmoProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  stock: number;
  status: string;
  category?: { name: string };
  image_url?: string;
  description?: string;
  sold_count?: number;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────
function useGcmmoBrowse(enabled: boolean) {
  return useQuery<{ products: GcmmoProduct[]; total: number }>({
    queryKey: ["gcmmo-browse"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/products/gcmmo-browse`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as any).error ?? "Lỗi kết nối gcmmo");
      }
      return res.json();
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

function useImportGcmmo() {
  return useMutation({
    mutationFn: async (params: { productIds: string[]; markup: number }) => {
      const res = await fetch(`${BASE}/api/products/import-gcmmo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const d = await res.json();
      if (!res.ok) throw new Error((d as any).error ?? "Lỗi import");
      return d as { ok: boolean; imported: number; updated: number };
    },
  });
}

// ── Main page ─────────────────────────────────────────────────────────────────
export function ProductsPage() {
  const { data: products, isLoading } = useListProducts();
  const qc = useQueryClient();
  const { toast } = useToast();

  // Import sheet state
  const [showImport, setShowImport] = useState(false);
  const [gcmmoSearch, setGcmmoSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [markup, setMarkup] = useState("10");

  // Local search
  const [search, setSearch] = useState("");
  const [filterActive, setFilterActive] = useState<"all" | "active" | "hidden">("all");

  const gcmmoBrowse = useGcmmoBrowse(showImport);
  const importMutation = useImportGcmmo();

  const filtered = useMemo(() => {
    if (!products) return [];
    return products.filter((p) => {
      const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase());
      const matchActive =
        filterActive === "all" ? true :
        filterActive === "active" ? p.isActive :
        !p.isActive;
      return matchSearch && matchActive;
    });
  }, [products, search, filterActive]);

  const gcmmoFiltered = useMemo(() => {
    if (!gcmmoBrowse.data?.products) return [];
    const q = gcmmoSearch.toLowerCase();
    return gcmmoBrowse.data.products.filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.category?.name?.toLowerCase().includes(q)
    );
  }, [gcmmoBrowse.data, gcmmoSearch]);

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function toggleAll() {
    if (selected.size === gcmmoFiltered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(gcmmoFiltered.map((p) => p.id)));
    }
  }

  async function handleImport() {
    if (selected.size === 0) return;
    const result = await importMutation.mutateAsync({
      productIds: [...selected],
      markup: Number(markup) || 0,
    });
    qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
    toast({ title: `✅ Import thành công: ${result.imported} mới, ${result.updated} cập nhật` });
    setShowImport(false);
    setSelected(new Set());
  }

  // Stats
  const gcmmoCount = products?.filter((p) => p.sourceId).length ?? 0;
  const totalProfit = products?.reduce((sum, p) => {
    const cost = (p as any).gcmmoPrice ?? 0;
    return cost > 0 ? sum + (p.price - cost) : sum;
  }, 0) ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sản phẩm</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {products?.length ?? 0} sản phẩm · {gcmmoCount} từ gcmmo.net
          </p>
        </div>
        <Button
          onClick={() => setShowImport(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Download className="mr-2 h-4 w-4" />
          Import từ gcmmo
        </Button>
      </div>

      {/* Summary cards */}
      {products && products.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">Tổng sản phẩm</p>
            <p className="text-2xl font-bold mt-1">{products.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {products.filter((p) => p.isActive).length} đang bán
            </p>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">Từ gcmmo.net</p>
            <p className="text-2xl font-bold mt-1 text-primary">{gcmmoCount}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Middleman tự động</p>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">Lời trung bình/sp</p>
            <p className="text-2xl font-bold mt-1 text-green-400">
              {gcmmoCount > 0 ? formatVND(Math.round(totalProfit / gcmmoCount)) : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Trên {gcmmoCount} sp gcmmo</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm sản phẩm..."
            className="pl-9 bg-background"
          />
        </div>
        <Button
          variant={filterActive === "all" ? "secondary" : "outline"}
          size="sm"
          onClick={() => setFilterActive("all")}
        >Tất cả</Button>
        <Button
          variant={filterActive === "active" ? "secondary" : "outline"}
          size="sm"
          onClick={() => setFilterActive("active")}
        >Đang bán</Button>
        <Button
          variant={filterActive === "hidden" ? "secondary" : "outline"}
          size="sm"
          onClick={() => setFilterActive("hidden")}
        >Đã ẩn</Button>
      </div>

      {/* Product list */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card h-20 animate-pulse" />
          ))}
        </div>
      ) : filtered.length > 0 ? (
        <div className="rounded-xl border bg-card divide-y">
          {filtered.map((p) => {
            const gcmmoPrice = (p as any).gcmmoPrice as number | null;
            const stock = (p as any).stock as number | null;
            const profit = gcmmoPrice && gcmmoPrice > 0 ? p.price - gcmmoPrice : null;
            const profitPct = profit && gcmmoPrice ? Math.round((profit / gcmmoPrice) * 100) : null;
            const isGcmmo = !!(p as any).sourceId;

            return (
              <Link
                key={p.id}
                href={`/products/${p.id}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-secondary/50 transition-colors cursor-pointer"
              >
                {/* Thumbnail */}
                {(p as any).imageUrl ? (
                  <img
                    src={(p as any).imageUrl}
                    alt={p.name}
                    className="h-12 w-12 rounded-lg object-cover border flex-shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                ) : (
                  <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Package className="h-5 w-5 text-primary" />
                  </div>
                )}

                {/* Name + badges */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm truncate">{p.name}</span>
                    {!p.isActive && (
                      <Badge variant="destructive" className="text-xs py-0">Ẩn</Badge>
                    )}
                    {isGcmmo && (
                      <Badge variant="secondary" className="text-xs py-0 text-primary border-primary/30">
                        gcmmo
                      </Badge>
                    )}
                    {p.category && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                        {p.category}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    {isGcmmo ? (
                      <>
                        <span>Kho gcmmo: <span className={`font-medium ${(stock ?? 0) > 0 ? "text-green-400" : "text-destructive"}`}>{stock ?? 0}</span></span>
                        {gcmmoPrice && <span>Giá gốc: <span className="font-medium text-foreground">{formatVND(gcmmoPrice)}</span></span>}
                      </>
                    ) : (
                      <span>Kho local: <span className="font-medium text-foreground">{p.inventoryCount}</span></span>
                    )}
                  </div>
                </div>

                {/* Price + profit */}
                <div className="text-right flex-shrink-0">
                  <p className="font-semibold text-sm">{formatVND(p.price)}</p>
                  {profit !== null && profit > 0 && (
                    <p className="text-xs text-green-400 mt-0.5 flex items-center justify-end gap-0.5">
                      <TrendingUp className="h-3 w-3" />
                      +{formatVND(profit)} ({profitPct}%)
                    </p>
                  )}
                </div>

                <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border bg-card flex flex-col items-center justify-center py-16 text-center">
          <ShoppingCart className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="font-medium mb-1">Chưa có sản phẩm nào</p>
          <p className="text-muted-foreground text-sm mb-4">
            Import sản phẩm từ gcmmo.net để bắt đầu bán hàng
          </p>
          <Button onClick={() => setShowImport(true)} className="bg-primary text-primary-foreground">
            <Download className="mr-2 h-4 w-4" />
            Import từ gcmmo
          </Button>
        </div>
      )}

      {/* ── Import Sheet ──────────────────────────────────────────────────────── */}
      <Sheet open={showImport} onOpenChange={setShowImport}>
        <SheetContent side="right" className="w-full sm:max-w-2xl bg-card border-l flex flex-col p-0">
          <SheetHeader className="p-6 border-b">
            <SheetTitle className="flex items-center gap-2">
              <ExternalLink className="h-4 w-4 text-primary" />
              Import sản phẩm từ gcmmo.net
            </SheetTitle>
            <p className="text-xs text-muted-foreground">
              Chọn sản phẩm muốn bán, đặt % markup và bấm Import
            </p>
          </SheetHeader>

          {/* Controls */}
          <div className="p-4 border-b space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={gcmmoSearch}
                  onChange={(e) => setGcmmoSearch(e.target.value)}
                  placeholder="Tìm sản phẩm gcmmo..."
                  className="pl-9 bg-background"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs whitespace-nowrap">Markup %</Label>
                <Input
                  type="number"
                  value={markup}
                  onChange={(e) => setMarkup(e.target.value)}
                  className="w-20 bg-background text-sm"
                  min="0"
                  max="500"
                />
              </div>
            </div>
            {gcmmoBrowse.data && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <button
                  className="flex items-center gap-1.5 hover:text-foreground transition-colors"
                  onClick={toggleAll}
                >
                  {selected.size === gcmmoFiltered.length && gcmmoFiltered.length > 0
                    ? <CheckSquare className="h-3.5 w-3.5 text-primary" />
                    : <Square className="h-3.5 w-3.5" />}
                  Chọn tất cả ({gcmmoFiltered.length})
                </button>
                {selected.size > 0 && (
                  <span className="text-primary font-medium">{selected.size} đã chọn</span>
                )}
              </div>
            )}
          </div>

          {/* Product list */}
          <div className="flex-1 overflow-y-auto">
            {gcmmoBrowse.isLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="ml-2 text-sm text-muted-foreground">Đang tải từ gcmmo.net...</span>
              </div>
            ) : gcmmoBrowse.isError ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <AlertCircle className="h-8 w-8 text-destructive" />
                <p className="text-sm text-muted-foreground text-center">
                  {(gcmmoBrowse.error as Error).message}
                </p>
                <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["gcmmo-browse"] })}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Thử lại
                </Button>
              </div>
            ) : gcmmoFiltered.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground text-sm">
                Không tìm thấy sản phẩm nào
              </div>
            ) : (
              <div className="divide-y">
                {gcmmoFiltered.map((p) => {
                  const isSelected = selected.has(p.id);
                  const sellPrice = Math.round(p.price * (1 + Number(markup) / 100));
                  const profit = sellPrice - p.price;

                  return (
                    <button
                      key={p.id}
                      onClick={() => toggleSelect(p.id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                        isSelected ? "bg-primary/5 hover:bg-primary/10" : "hover:bg-secondary/50"
                      }`}
                    >
                      {/* Checkbox */}
                      <div className={`flex-shrink-0 h-4 w-4 rounded border-2 flex items-center justify-center transition-colors ${
                        isSelected ? "bg-primary border-primary" : "border-muted-foreground/40"
                      }`}>
                        {isSelected && <X className="h-2.5 w-2.5 text-primary-foreground" style={{ strokeWidth: 3 }} />}
                      </div>

                      {/* Thumbnail */}
                      {p.image_url ? (
                        <img
                          src={p.image_url}
                          alt={p.name}
                          className="h-12 w-12 rounded-lg object-cover border flex-shrink-0"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                      ) : (
                        <div className="h-12 w-12 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0">
                          <Package className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{p.name}</p>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                          {p.category?.name && <span className="px-1.5 py-0.5 rounded bg-secondary">{p.category.name}</span>}
                          <span>Kho: <span className={p.stock > 0 ? "text-green-400 font-medium" : "text-destructive"}>{p.stock}</span></span>
                        </div>
                      </div>

                      {/* Pricing */}
                      <div className="text-right flex-shrink-0">
                        <p className="text-xs text-muted-foreground line-through">{formatVND(p.price)}</p>
                        <p className="text-sm font-semibold">{formatVND(sellPrice)}</p>
                        {profit > 0 && (
                          <p className="text-xs text-green-400">+{formatVND(profit)}</p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 border-t bg-card">
            <Button
              className="w-full bg-primary text-primary-foreground"
              disabled={selected.size === 0 || importMutation.isPending}
              onClick={handleImport}
            >
              {importMutation.isPending ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Đang import...</>
              ) : (
                <><Download className="mr-2 h-4 w-4" /> Import {selected.size > 0 ? `${selected.size} sản phẩm` : "sản phẩm"}</>
              )}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
