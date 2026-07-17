import { useListBotUsers } from "@workspace/api-client-react";
import { Users, MessageCircle } from "lucide-react";

export function UsersPage() {
  const { data: users, isLoading } = useListBotUsers();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Khách hàng</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {users?.length ?? 0} người dùng Telegram
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card h-14 animate-pulse" />
          ))}
        </div>
      ) : users && users.length > 0 ? (
        <div className="rounded-xl border bg-card divide-y">
          {users.map((user) => (
            <div key={user.id} className="flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-4">
                <div className="rounded-full bg-primary/10 text-primary h-9 w-9 flex items-center justify-center text-sm font-bold">
                  {(user.firstName?.[0] ?? user.username?.[0] ?? "?").toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-medium">
                    {[user.firstName, user.lastName].filter(Boolean).join(" ") || "—"}
                  </p>
                  {user.username && (
                    <p className="text-xs text-muted-foreground">@{user.username}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <div className="flex items-center gap-1">
                  <MessageCircle className="h-3.5 w-3.5" />
                  ID: {user.telegramId}
                </div>
                <span>{new Date(user.createdAt).toLocaleDateString("vi-VN")}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border bg-card flex flex-col items-center justify-center py-16 text-center">
          <Users className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-muted-foreground">Chưa có người dùng. Họ sẽ xuất hiện khi dùng bot Telegram.</p>
        </div>
      )}
    </div>
  );
}
