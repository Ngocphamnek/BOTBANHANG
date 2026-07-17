import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { getListProductsQueryKey } from "@workspace/api-client-react";
import { formatVND } from "@/lib/utils";
import {
  Star, RefreshCw, Search, Package, ShoppingCart, ThumbsUp, ThumbsDown,
  TrendingUp, AlertCircle, Loader2, CheckCircle2, XCircle, ChevronDown,
  ArrowUpDown, Store, ExternalLink, Download, X, CheckSquare, Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

// ── Types ─────────────────────────────────────────────────────────────────────
interface GcmmoSeller {
  id: string;
  slug: string;
  name: string;
  rating: number;
  review_count: number;
  positive_count: number;
  negative_count: number;
  positive_rate: number;
  total_sold: number;
  product_count: number;
  avatar_url?: string;
  created_at?: string;
  min_price: number;
  max_price: number;
  categories: string[];
}

interface GcmmoProduct {
  id: string;
  name: string;
  price: number;
  stock: number;
  sold_count: number;
  status: string;
  image_url?: string;
  category?: { name: string };
}

type SortKey = "score" | "rating" | "reviews" | "sold" | "products";

// ── Helpers ───────────────────────────────────────────────────────────────────
function qualityTier(seller: GcmmoSeller): { label: string; color: string; bg: string } {
  const score =
    seller.rating * 0.5 +
    Math.log1p(seller.review_count) * 0.3 +
    Math.log1p(seller.total_sold) * 0.2;
  if (score >= 4) return { label: "Xuất sắc", color: "text-emerald-400", bg: "bg-emerald-400/10 border-emerald-400/20" };
  if (score >= 2.5) return { label: "Tốt", color: "text-primary", bg: "bg-primary/10 border-primary/20" };
  if (score >= 1) return { label: "Trung bình", color: "text-amber-400", bg: "bg-amber-400/10 border-amber-400/20" };
  return { label: "Mới/Ít dữ liệu", color: "text-muted-foreground", bg: "bg-muted border-border" };
}

function StarBar({ rating }: { rating: number }) {
  const filled = Math.round(rating);
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={cn(
            "h-3.5 w-3.5",
            i <= filled ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"
          )}
        />
      ))}
    </div>
  );
}

// ── Hooks ─────────────────────────────────────────────────────────────────────
function useSellers(enabled = true) {
  return useQuery<{ sellers: GcmmoSeller[]; cached: boolean; cachedAt: string }>({
    queryKey: ["gcmmo-sellers"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/sellers`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as any).error ?? "Lỗi kết nối gcmmo");
      }
      return res.json();
    },
    enabled,
    staleTime: 10 * 60 * 1000,
  });
}

function useSellerProducts(slug: string | null) {
  return useQuery<{ products: GcmmoProduct[]; total: number }>({
    queryKey: ["gcmmo-seller-products", slug],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/sellers/${slug}/products`);
      if (!res.ok) throw new Error("Không lấy được sản phẩm");
      return res.json();
    },
    enabled: !!slug,
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
export function SellersPage() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("score");
  const [selectedSeller, setSelectedSeller] = useState<GcmmoSeller | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [markup, setMarkup] = useState("10");

  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useSellers();
  const sellerProducts = useSellerProducts(selectedSeller?.slug ?? null);
  const importMutation = useImportGcmmo();

  const sellers = useMemo(() => {
    if (!data?.sellers) return [];
    let list = data.sellers.filter((s) =>
      !search || s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.categories.some((c) => c.toLowerCase().includes(search.toLowerCase()))
    );
    list = [...list].sort((a, b) => {
      switch (sort) {
        case "rating": return b.rating - a.rating;
        case "reviews": return b.review_count - a.review_count;
        case "sold": return b.total_sold - a.total_sold;
        case "products": return b.product_count - a.product_count;
        default: {
          const scoreA = a.rating * 0.5 + Math.log1p(a.review_count) * 0.3 + Math.log1p(a.total_sold) * 0.2;
          const scoreB = b.rating * 0.5 + Math.log1p(b.review_count) * 0.3 + Math.log1p(b.total_sold) * 0.2;
          return scoreB - scoreA;
        }
      }
    });
    return list;
  }, [data, search, sort]);

  async function handleRefresh() {
    await fetch(`${BASE}/api/sellers?refresh=1`);
    qc.invalidateQueries({ queryKey: ["gcmmo-sellers"] });
    refetch();
  }

  function toggleProduct(id: string) {
    setSelectedProducts((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function toggleAllProducts() {
    const all = sellerProducts.data?.products ?? [];
    if (selectedProducts.size === all.length) setSelectedProducts(new Set());
    else setSelectedProducts(new Set(all.map((p) => p.id)));
  }

  async function handleImport() {
    if (selectedProducts.size === 0) return;
    const result = await importMutation.mutateAsync({
      productIds: [...selectedProducts],
      markup: Number(markup) || 0,
    });
    qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
    toast({ title: `✅ Import thành công: ${result.imported} mới, ${result.updated} cập nhật` });
    setSelectedProducts(new Set());
  }

  const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: "score", label: "Tổng hợp" },
    { key: "rating", label: "Sao cao" },
    { key: "reviews", label: "Nhiều đánh giá" },
    { key: "sold", label: "Nhiều đơn hàng" },
    { key: "products", label: "Nhiều sản phẩm" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Đánh giá shop</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Xem xếp hạng từng gian hàng trên gcmmo.net để chọn nguồn hàng chất lượng
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleRefresh}
          disabled={isFetching}
          className="gap-2"
        >
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          Làm mới
        </Button>
      </div>

      {/* Stats bar */}
      {data && (
        <div className="grid grid-cols-4 gap-4">
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">Tổng shop</p>
            <p className="text-2xl font-bold mt-1">{data.sellers.length}</p>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">Shop xuất sắc</p>
            <p className="text-2xl font-bold mt-1 text-emerald-400">
              {data.sellers.filter((s) => qualityTier(s).label === "Xuất sắc").length}
            </p>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">Tổng lượt đánh giá</p>
            <p className="text-2xl font-bold mt-1">
              {data.sellers.reduce((s, x) => s + x.review_count, 0).toLocaleString()}
            </p>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">Cache lúc</p>
            <p className="text-sm font-medium mt-1 text-muted-foreground">
              {data.cached ? new Date(data.cachedAt).toLocaleTimeString("vi-VN") : "Vừa tải"}
            </p>
          </div>
        </div>
      )}

      {/* Search + Sort */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm shop theo tên hoặc danh mục..."
            className="pl-9 bg-background"
          />
        </div>
        <div className="flex gap-1 rounded-lg border bg-card p-1">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setSort(opt.key)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                sort === opt.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {isLoading && (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Đang tải dữ liệu shop từ gcmmo.net...</p>
          <p className="text-xs text-muted-foreground">Lần đầu có thể mất 15–30 giây</p>
        </div>
      )}

      {error && (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-destructive">{(error as Error).message}</p>
          <Button variant="outline" onClick={() => refetch()}>Thử lại</Button>
        </div>
      )}

      {!isLoading && !error && sellers.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-2">
          <Store className="h-8 w-8 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">Không tìm thấy shop nào</p>
        </div>
      )}

      {sellers.length > 0 && (
        <div className="space-y-3">
          {sellers.map((seller, idx) => {
            const tier = qualityTier(seller);
            return (
              <div
                key={seller.id}
                className="rounded-xl border bg-card p-5 hover:border-primary/40 transition-all cursor-pointer group"
                onClick={() => { setSelectedSeller(seller); setSelectedProducts(new Set()); }}
              >
                <div className="flex items-center gap-4">
                  {/* Rank */}
                  <div className="text-2xl font-black text-muted-foreground/30 w-8 text-center select-none">
                    {idx + 1}
                  </div>

                  {/* Avatar */}
                  <div className="h-12 w-12 rounded-xl bg-secondary flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {seller.avatar_url ? (
                      <img src={seller.avatar_url} alt={seller.name} className="h-full w-full object-cover" />
                    ) : (
                      <Store className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>

                  {/* Name + tier */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm truncate">{seller.name || seller.slug}</span>
                      <span className={cn("text-xs px-2 py-0.5 rounded-full border font-medium", tier.bg, tier.color)}>
                        {tier.label}
                      </span>
                    </div>
                    {seller.categories.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {seller.categories.slice(0, 3).map((c) => (
                          <span key={c} className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{c}</span>
                        ))}
                        {seller.categories.length > 3 && (
                          <span className="text-xs text-muted-foreground">+{seller.categories.length - 3}</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Rating */}
                  <div className="flex-shrink-0 text-center px-4">
                    <div className="flex items-center gap-1 justify-center">
                      <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                      <span className="font-bold text-lg">
                        {seller.rating > 0 ? seller.rating.toFixed(1) : "—"}
                      </span>
                    </div>
                    <StarBar rating={seller.rating} />
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {seller.review_count > 0 ? `${seller.review_count.toLocaleString()} đánh giá` : "Chưa có đánh giá"}
                    </p>
                  </div>

                  {/* Positive rate */}
                  {seller.review_count > 0 && (
                    <div className="flex-shrink-0 text-center px-3 hidden md:block">
                      <div className="flex items-center gap-1 justify-center">
                        {seller.positive_rate >= 80
                          ? <ThumbsUp className="h-4 w-4 text-emerald-400" />
                          : <ThumbsDown className="h-4 w-4 text-destructive" />}
                        <span className={cn(
                          "font-bold",
                          seller.positive_rate >= 80 ? "text-emerald-400" : "text-destructive"
                        )}>
                          {seller.positive_rate > 0 ? `${seller.positive_rate}%` : "—"}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">Hài lòng</p>
                    </div>
                  )}

                  {/* Stats */}
                  <div className="flex gap-4 flex-shrink-0 hidden lg:flex">
                    <div className="text-center">
                      <p className="font-semibold text-sm">{seller.total_sold.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <ShoppingCart className="h-3 w-3" /> Đã bán
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="font-semibold text-sm">{seller.product_count}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Package className="h-3 w-3" /> Sản phẩm
                      </p>
                    </div>
                    {seller.max_price > 0 && (
                      <div className="text-center">
                        <p className="font-semibold text-sm">{formatVND(seller.min_price)}</p>
                        <p className="text-xs text-muted-foreground">Từ</p>
                      </div>
                    )}
                  </div>

                  {/* CTA */}
                  <button
                    className="flex-shrink-0 text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1"
                    onClick={(e) => { e.stopPropagation(); setSelectedSeller(seller); setSelectedProducts(new Set()); }}
                  >
                    Xem shop <ExternalLink className="h-3 w-3" />
                  </button>
                </div>

                {/* Progress bar: positive rate */}
                {seller.review_count > 0 && seller.positive_rate > 0 && (
                  <div className="mt-3 ml-12">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            seller.positive_rate >= 80 ? "bg-emerald-400" :
                            seller.positive_rate >= 60 ? "bg-amber-400" : "bg-destructive"
                          )}
                          style={{ width: `${seller.positive_rate}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {seller.positive_count > 0 && `${seller.positive_count}✓`}
                        {seller.negative_count > 0 && ` ${seller.negative_count}✗`}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Seller products sheet */}
      <Sheet open={!!selectedSeller} onOpenChange={(o) => { if (!o) setSelectedSeller(null); }}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto flex flex-col">
          <SheetHeader className="flex-shrink-0">
            <SheetTitle className="flex items-center gap-2">
              <Store className="h-5 w-5 text-primary" />
              {selectedSeller?.name || selectedSeller?.slug}
            </SheetTitle>
            {selectedSeller && (
              <div className="flex items-center gap-4 pt-1">
                <div className="flex items-center gap-1.5">
                  <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                  <span className="font-bold">{selectedSeller.rating > 0 ? selectedSeller.rating.toFixed(1) : "—"}</span>
                  <span className="text-xs text-muted-foreground">({selectedSeller.review_count.toLocaleString()} đánh giá)</span>
                </div>
                {selectedSeller.positive_rate > 0 && (
                  <div className="flex items-center gap-1">
                    <ThumbsUp className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="text-sm text-emerald-400 font-medium">{selectedSeller.positive_rate}% hài lòng</span>
                  </div>
                )}
                <span className={cn("text-xs px-2 py-0.5 rounded-full border", qualityTier(selectedSeller).bg, qualityTier(selectedSeller).color)}>
                  {qualityTier(selectedSeller).label}
                </span>
              </div>
            )}
          </SheetHeader>

          {/* Import controls */}
          <div className="border rounded-lg p-3 bg-muted/30 flex-shrink-0 mt-4">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <Label className="text-xs text-muted-foreground">Markup (%)</Label>
                <Input
                  type="number"
                  value={markup}
                  onChange={(e) => setMarkup(e.target.value)}
                  className="mt-1 h-8 text-sm bg-background"
                  min={0}
                  max={500}
                />
              </div>
              <div className="flex-1 flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Đã chọn: {selectedProducts.size} sản phẩm</span>
                <Button
                  size="sm"
                  disabled={selectedProducts.size === 0 || importMutation.isPending}
                  onClick={handleImport}
                >
                  {importMutation.isPending ? (
                    <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Đang import...</>
                  ) : (
                    <><Download className="mr-1.5 h-3.5 w-3.5" />Import {selectedProducts.size > 0 ? selectedProducts.size : ""} sản phẩm</>
                  )}
                </Button>
              </div>
            </div>
          </div>

          {/* Product list */}
          <div className="flex-1 overflow-y-auto mt-4">
            {sellerProducts.isLoading && (
              <div className="flex items-center justify-center py-12 gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Đang tải sản phẩm...</span>
              </div>
            )}
            {sellerProducts.data && (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium">
                    {sellerProducts.data.total} sản phẩm
                  </span>
                  <button
                    className="text-xs text-primary underline"
                    onClick={toggleAllProducts}
                  >
                    {selectedProducts.size === sellerProducts.data.products.length ? "Bỏ chọn tất cả" : "Chọn tất cả"}
                  </button>
                </div>
                <div className="space-y-2">
                  {sellerProducts.data.products.map((p) => {
                    const isSelected = selectedProducts.has(p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() => toggleProduct(p.id)}
                        className={cn(
                          "w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all",
                          isSelected
                            ? "border-primary bg-primary/5"
                            : "border-border bg-card hover:border-primary/30"
                        )}
                      >
                        {/* Checkbox */}
                        {isSelected
                          ? <CheckSquare className="h-4 w-4 text-primary flex-shrink-0" />
                          : <Square className="h-4 w-4 text-muted-foreground flex-shrink-0" />}

                        {/* Image */}
                        {p.image_url ? (
                          <img src={p.image_url} alt={p.name} className="h-10 w-10 rounded object-cover flex-shrink-0" />
                        ) : (
                          <div className="h-10 w-10 rounded bg-secondary flex items-center justify-center flex-shrink-0">
                            <Package className="h-4 w-4 text-muted-foreground" />
                          </div>
                        )}

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{p.name}</p>
                          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                            {p.category?.name && <span className="px-1.5 py-0.5 rounded bg-secondary">{p.category.name}</span>}
                            <span className={p.stock > 0 ? "text-emerald-400" : "text-destructive"}>
                              Kho: {p.stock === 9999 ? "∞" : p.stock}
                            </span>
                            {p.sold_count > 0 && <span>Đã bán: {p.sold_count}</span>}
                          </div>
                        </div>

                        {/* Price */}
                        <div className="text-right flex-shrink-0">
                          <p className="text-sm font-semibold">{formatVND(p.price)}</p>
                          {Number(markup) > 0 && (
                            <p className="text-xs text-emerald-400">
                              → {formatVND(Math.round(p.price * (1 + Number(markup) / 100)))}
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
