# GC MMO Shop — Bot Bán Hàng

Hệ thống bán hàng tự động tích hợp bot Telegram + bảng điều khiển admin. Đồng bộ sản phẩm từ gcmmo.net, tự động giao hàng, quản lý ví người dùng và hỗ trợ AI bán hàng qua Gemini.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — chạy API server (port 8080)
- `pnpm --filter @workspace/admin run dev` — chạy admin panel (port 23744)
- `pnpm run typecheck` — kiểm tra kiểu toàn bộ packages
- `pnpm run build` — typecheck + build tất cả packages
- `pnpm --filter @workspace/api-spec run codegen` — tái tạo hooks và Zod schemas từ OpenAPI spec
- `pnpm --filter @workspace/db run push` — đẩy thay đổi DB schema (chỉ dev)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Bot: Grammy (Telegram Bot API)
- AI: Google Gemini (`@google/genai`)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite + Tailwind CSS + shadcn/ui

## Environment Variables cần thiết

- `DATABASE_URL` — Postgres connection string (tự động có)
- `TELEGRAM_BOT_TOKEN` — Token bot Telegram (từ @BotFather)
- `GCMMO_ACCESS_TOKEN` — Token API gcmmo.net (hoặc cấu hình qua trang Kết nối)
- `SESSION_SECRET` — Secret cho cookie session

## Where things live

- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/api-server/src/bot/` — Logic Telegram bot (Grammy)
- `artifacts/api-server/src/lib/` — gcmmo API, sync, scraper, oauth
- `artifacts/admin/src/pages/` — React admin pages
- `lib/db/src/schema/` — Drizzle ORM table schemas
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth)

## Architecture decisions

- Bot Telegram dùng Grammy, tích hợp AI bán hàng qua Google Gemini
- Đồng bộ sản phẩm từ gcmmo.net qua API token hoặc Playwright browser auth
- Ví người dùng lưu trên DB, giao dịch nạp tiền qua VietQR / admin xác nhận
- Admin panel dùng React Query hooks từ codegen — không fetch thủ công

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
