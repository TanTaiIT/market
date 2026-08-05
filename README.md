# Chợ Tốt Clone — Backend

Marketplace/Classifieds API. Stack **2026**: Express + MongoDB (Mongoose) + **TypeScript**, kiến trúc **feature-based** (`src/features/`).

- **Validation + OpenAPI**: 1 schema Zod dùng chung (validate + type + docs) — `zod-to-openapi`
- **Docs**: Scalar API Reference tại `/docs` (spec `/openapi.json`)
- **Logger**: Pino (JSON structured, `pino-pretty` khi dev)
- **Auth**: JWT access + refresh
- **Realtime**: Socket.IO (chat)
- **Cache / rate limit / queue**: Redis + BullMQ (optional ở dev)

## Yêu cầu
- Node.js >= 20
- MongoDB (local hoặc qua `docker-compose`)
- Redis (tuỳ chọn — app vẫn chạy không cần Redis)

## Bắt đầu

```bash
cp .env.example .env      # sửa MONGO_URI, JWT_SECRET, JWT_REFRESH_SECRET
npm install
npm run dev               # ts-node-dev, hot reload
```

Hoặc chạy toàn bộ bằng Docker:

```bash
docker-compose up --build
```

- API base: `http://localhost:5000/api/v1`
- Health: `http://localhost:5000/health`
- Docs (Scalar): `http://localhost:5000/docs`

## Scripts

| Lệnh | Mô tả |
|---|---|
| `npm run dev` | Chạy dev (hot reload) |
| `npm run build` | Biên dịch TS → `dist/` (tsc + tsc-alias) |
| `npm start` | Chạy production từ `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config) |
| `npm test` | Jest + ts-jest + mongodb-memory-server |
| `npm run seed` | Seed dữ liệu mẫu |

## Cấu trúc

```
src/
├── config/        env, database, logger (pino), redis, openapi
├── features/      auth, user, listing (core) + category, chat, upload, search, review, notification (skeleton)
│   └── <feature>/ <feature>.{model,repository,service,controller,routes,schema,types}.ts
├── middlewares/   auth, error, notFound, rateLimiter, validate, upload
├── common/        errors, utils, constants, types
├── sockets/       socket.io (chat)
├── jobs/          BullMQ (expire listing...)
├── app.ts         khởi tạo express
└── server.ts      entrypoint
```

## Trạng thái module

| Module | Trạng thái | Endpoint gốc |
|---|---|---|
| auth | ✅ Core | `POST /auth/{register,login,refresh}` |
| user | ✅ Core | `GET/PATCH/DELETE /users/me`, `GET /users/:id` |
| listing | ✅ Core | `GET /listings`, `GET /listings/nearby`, `GET/POST/PATCH/DELETE /listings/:id` |
| category | 🚧 Skeleton (501) | `/categories` |
| chat | 🚧 Skeleton (501) | `/chats` (+ socket) |
| upload | 🚧 Skeleton (501) | `/uploads` |
| search | 🚧 Skeleton (501) | `/search` |
| review | 🚧 Skeleton (501) | `/reviews` |
| notification | 🚧 Skeleton (501) | `/notifications` |

> Module skeleton trả `501 Not Implemented` kèm ghi chú TODO trong `*.routes.ts` để triển khai tiếp.

## Ghi chú thiết kế
- **Listing**: `status` (draft/pending/active/sold/expired/rejected/hidden), `location` GeoJSON + `2dsphere` (tìm gần), `images: string[]` (URL, ảnh thật ở S3/Cloudinary), `expiresAt` TTL index (tự hết hạn), text index (title+description), compound index `(category, status, createdAt)`.
- **Soft delete**: `deletedAt` cho user & listing (pre-find tự loại trừ).
- **Response chuẩn**: `{ success, message, data, meta? }`.
