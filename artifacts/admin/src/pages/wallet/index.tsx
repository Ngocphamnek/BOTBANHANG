import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatVND } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  Wallet, Users, ArrowUpCircle, ArrowDownCircle, RefreshCw,
  Search, Plus, History, ChevronDown, ChevronUp, AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

type BotUser = {
  id: number;
  telegramId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  balance: number;
  createdAt: string;
};

type WalletTx = {
  id: number;
  telegramUserId: number;
  type: "deposit" | "purchase" | "refund" | "adjustment";
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  note: string | null;
  orderId: number | null;
  createdAt: string;
};

function useWalletUsers() {
  return useQuery<BotUser[]>({
    queryKey: ["wallet-users"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/wallet/users`);
      return res.json();
    },
  });
}

function useWalletTransactions(telegramId?: number) {
  return useQuery<{ transactions: WalletTx[]; total: number }>({
    queryKey: ["wallet-transactions", telegramId],
    queryFn: async () => {
      const url = telegramId
        ? `${BASE}/api/wallet/transactions?telegram_id=${telegramId}&limit=50`
        : `${BASE}/api/wallet/transactions?limit=50`;
      const res = await fetch(url);
      return res.json();
    },
  });
}

const typeConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  deposit: { label: "Nạp tiền", color: "text-green-400", icon: <ArrowUpCircle className="h-3.5 w-3.5" /> },
  purchase: { label: "Mua hàng", color: "text-red-400", icon: <ArrowDownCircle className="h-3.5 w-3.5" /> },
  refund: { label: "Hoàn tiền", color: "text-blue-400", icon: <ArrowUpCircle className="h-3.5 w-3.5" /> },
  adjustment: { label: "Điều chỉnh", color: "text-yellow-400", icon: <RefreshCw className="h-3.5 w-3.5" /> },
};

function TopupDialog({ user, onClose }: { user: BotUser; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const { toast } = useToast();
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/wallet/topup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramId: user.telegramId, amount: parseInt(amount), note }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "✅ Nạp tiền thành công",
        description: `${displayName(user)} nhận +${formatVND(data.amount)} — Số dư mới: ${formatVND(data.balanceAfter)}`,
      });
      qc.invalidateQueries({ queryKey: ["wallet-users"] });
      qc.invalidateQueries({ queryKey: ["wallet-transactions"] });
      onClose();
    },
    onError: (err: Error) => toast({ title: "Lỗi", description: err.message, variant: "destructive" }),
  });

  const presets = [10000, 20000, 50000, 100000, 200000, 500000];

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>💰 Nạp tiền cho {displayName(user)}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="rounded-lg bg-secondary/40 p-3 text-sm space-y-1">
          <div className="flex justify-between"><span className="text-muted-foreground">Telegram ID:</span><code className="text-xs">{user.telegramId}</code></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Số dư hiện tại:</span><span className="font-semibold text-green-400">{formatVND(user.balance)}</span></div>
        </div>

        <div className="space-y-2">
          <Label>Số tiền nạp (VNĐ)</Label>
          <Input
            type="number"
            placeholder="Nhập số tiền..."
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p}
                onClick={() => setAmount(String(p))}
                className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent transition-colors"
              >
                {formatVND(p)}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Ghi chú (tùy chọn)</Label>
          <Input
            placeholder="VD: chuyển khoản MB 14/07..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {amount && parseInt(amount) > 0 && (
          <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-3 text-sm">
            Sau nạp: <span className="font-bold text-green-400">{formatVND(user.balance + parseInt(amount))}</span>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Hủy</Button>
        <Button
          onClick={() => mutation.mutate()}
          disabled={!amount || parseInt(amount) <= 0 || mutation.isPending}
          className="bg-green-600 hover:bg-green-700"
        >
          {mutation.isPending ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
          Xác nhận nạp
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function displayName(u: BotUser) {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return name || u.username || `ID ${u.telegramId}`;
}

export function WalletPage() {
  const [search, setSearch] = useState("");
  const [topupUser, setTopupUser] = useState<BotUser | null>(null);
  const [selectedUser, setSelectedUser] = useState<BotUser | null>(null);

  const { data: users = [], isLoading: usersLoading } = useWalletUsers();
  const { data: allTx, isLoading: txLoading } = useWalletTransactions(selectedUser?.telegramId);

  const filtered = users.filter((u) => {
    const q = search.toLowerCase();
    return (
      !q ||
      displayName(u).toLowerCase().includes(q) ||
      String(u.telegramId).includes(q) ||
      (u.username ?? "").toLowerCase().includes(q)
    );
  });

  const totalBalance = users.reduce((s, u) => s + u.balance, 0);
  const totalUsers = users.length;
  const usersWithBalance = users.filter((u) => u.balance > 0).length;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="h-6 w-6" /> Quản lý ví người dùng</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Nạp tiền thủ công sau khi xác nhận chuyển khoản. Mỗi user có ví Telegram riêng biệt với tài khoản gcmmo.net.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Users className="h-3.5 w-3.5" /> Tổng users</p>
          <p className="text-2xl font-bold mt-1">{totalUsers}</p>
          <p className="text-xs text-muted-foreground">{usersWithBalance} có số dư</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Wallet className="h-3.5 w-3.5" /> Tổng số dư trong hệ thống</p>
          <p className="text-2xl font-bold mt-1 text-green-400">{formatVND(totalBalance)}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5" /> Hướng dẫn nạp</p>
          <p className="text-xs mt-1 text-muted-foreground">User chuyển khoản → Admin xác nhận → Nhấn nút Nạp tiền bên dưới</p>
        </div>
      </div>

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users"><Users className="h-4 w-4 mr-1.5" /> Danh sách users</TabsTrigger>
          <TabsTrigger value="transactions"><History className="h-4 w-4 mr-1.5" /> Lịch sử giao dịch</TabsTrigger>
        </TabsList>

        {/* Users tab */}
        <TabsContent value="users" className="mt-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="Tìm tên, username, Telegram ID..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>

          <div className="rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Người dùng</TableHead>
                  <TableHead>Telegram ID</TableHead>
                  <TableHead className="text-right">Số dư ví</TableHead>
                  <TableHead>Ngày tham gia</TableHead>
                  <TableHead className="text-right">Hành động</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersLoading ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Đang tải...</TableCell></TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Không có user nào</TableCell></TableRow>
                ) : filtered.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{displayName(u)}</p>
                        {u.username && <p className="text-xs text-muted-foreground">@{u.username}</p>}
                      </div>
                    </TableCell>
                    <TableCell><code className="text-xs">{u.telegramId}</code></TableCell>
                    <TableCell className="text-right">
                      <span className={`font-semibold ${u.balance > 0 ? "text-green-400" : "text-muted-foreground"}`}>
                        {formatVND(u.balance)}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(u.createdAt).toLocaleDateString("vi-VN")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => setSelectedUser(selectedUser?.telegramId === u.telegramId ? null : u)}
                        >
                          <History className="h-3.5 w-3.5 mr-1" />
                          Lịch sử
                          {selectedUser?.telegramId === u.telegramId
                            ? <ChevronUp className="h-3 w-3 ml-1" />
                            : <ChevronDown className="h-3 w-3 ml-1" />}
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 text-xs bg-green-600 hover:bg-green-700"
                          onClick={() => setTopupUser(u)}
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" />
                          Nạp tiền
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Inline transaction history for selected user */}
          {selectedUser && (
            <div className="mt-4 rounded-xl border bg-card/50 p-4 space-y-3">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <History className="h-4 w-4" />
                Lịch sử giao dịch: {displayName(selectedUser)}
              </h3>
              {txLoading ? (
                <p className="text-sm text-muted-foreground">Đang tải...</p>
              ) : (allTx?.transactions ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">Chưa có giao dịch nào.</p>
              ) : (
                <div className="space-y-2">
                  {(allTx?.transactions ?? []).map((tx) => {
                    const cfg = typeConfig[tx.type] ?? typeConfig.adjustment;
                    return (
                      <div key={tx.id} className="flex items-center justify-between text-sm rounded-lg bg-secondary/30 px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className={cfg.color}>{cfg.icon}</span>
                          <div>
                            <p className="font-medium">{cfg.label}</p>
                            {tx.note && <p className="text-xs text-muted-foreground">{tx.note}</p>}
                          </div>
                        </div>
                        <div className="text-right">
                          <p className={`font-semibold ${tx.amount > 0 ? "text-green-400" : "text-red-400"}`}>
                            {tx.amount > 0 ? "+" : ""}{formatVND(Math.abs(tx.amount))}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Dư: {formatVND(tx.balanceAfter)} — {new Date(tx.createdAt).toLocaleDateString("vi-VN")}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* All transactions tab */}
        <TabsContent value="transactions" className="mt-4">
          <AllTransactions />
        </TabsContent>
      </Tabs>

      {/* Topup dialog */}
      <Dialog open={!!topupUser} onOpenChange={(v) => !v && setTopupUser(null)}>
        {topupUser && <TopupDialog user={topupUser} onClose={() => setTopupUser(null)} />}
      </Dialog>
    </div>
  );
}

function AllTransactions() {
  const { data, isLoading } = useWalletTransactions();
  const txs = data?.transactions ?? [];

  return (
    <div className="rounded-xl border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Loại</TableHead>
            <TableHead>User</TableHead>
            <TableHead className="text-right">Số tiền</TableHead>
            <TableHead className="text-right">Số dư sau</TableHead>
            <TableHead>Ghi chú</TableHead>
            <TableHead>Thời gian</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Đang tải...</TableCell></TableRow>
          ) : txs.length === 0 ? (
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Chưa có giao dịch nào</TableCell></TableRow>
          ) : txs.map((tx) => {
            const cfg = typeConfig[tx.type] ?? typeConfig.adjustment;
            return (
              <TableRow key={tx.id}>
                <TableCell>
                  <Badge variant="outline" className={`gap-1 ${cfg.color}`}>
                    {cfg.icon}{cfg.label}
                  </Badge>
                </TableCell>
                <TableCell><code className="text-xs">{tx.telegramUserId}</code></TableCell>
                <TableCell className={`text-right font-semibold ${tx.amount > 0 ? "text-green-400" : "text-red-400"}`}>
                  {tx.amount > 0 ? "+" : ""}{formatVND(Math.abs(tx.amount))}
                </TableCell>
                <TableCell className="text-right text-sm">{formatVND(tx.balanceAfter)}</TableCell>
                <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{tx.note ?? "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(tx.createdAt).toLocaleString("vi-VN")}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
