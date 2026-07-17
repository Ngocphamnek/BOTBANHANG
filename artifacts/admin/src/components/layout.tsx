import { Link, useLocation } from "wouter"
import { LayoutDashboard, Package, ShoppingCart, Users, RefreshCw, Link2, Settings, Wallet, Store } from "lucide-react"

export function Sidebar() {
  const [location] = useLocation()

  const navItems = [
    { href: "/", label: "Tổng quan", icon: LayoutDashboard },
    { href: "/products", label: "Sản phẩm", icon: Package },
    { href: "/orders", label: "Đơn hàng", icon: ShoppingCart },
    { href: "/users", label: "Khách hàng", icon: Users },
    { href: "/wallet", label: "Quản lý ví", icon: Wallet },
    { href: "/sellers", label: "Đánh giá shop", icon: Store },
    { href: "/sync", label: "Đồng bộ gcmmo", icon: RefreshCw },
    { href: "/gcmmo-connect", label: "Kết nối gcmmo", icon: Link2 },
    { href: "/settings", label: "Cài đặt", icon: Settings },
  ]

  return (
    <div className="flex h-screen w-64 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 items-center border-b px-6">
        <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
          <div className="h-6 w-6 rounded bg-primary" />
          GC MMO
        </div>
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {navItems.map((item) => {
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href))
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          )
        })}
      </nav>
      <div className="border-t p-4">
        <div className="flex items-center gap-3 rounded-md px-3 py-2 text-xs text-muted-foreground">
          <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
          Hệ thống trực tuyến
        </div>
      </div>
    </div>
  )
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <div className="p-8 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  )
}
