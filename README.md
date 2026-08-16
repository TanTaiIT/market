# Chợ Tốt Clone — Backend

Marketplace/Classifieds API. Express + MongoDB (Mongoose) + **TypeScript**, kiến trúc
**feature-based** (`src/features/`).

- **Validation + OpenAPI**: 1 schema Zod dùng chung (validate + type + docs) — `zod-to-openapi`
- **Docs**: Scalar API Reference tại `/docs` (spec `/openapi.json`)
- **Logger**: winston (console, có timestamp; access log tự viết trong `app.ts`)
- **Auth**: JWT access + refresh
- **Realtime**: Socket.IO (chat)
- **Rate limit / socket adapter**: Redis (optional — không có thì fallback in-memory)

## Yêu cầu
- Node.js >= 20
- MongoDB (local hoặc qua `docker-compose`)
- Redis (tuỳ chọn — app vẫn chạy không cần Redis)

## Bắt đầu

```bash
cp .env.example .env                            # phần dùng chung (PORT, API_PREFIX, token TTL)
cp .env.development.example .env.development    # sửa MONGO_URI (db market-dev) + JWT secret
npm install
npm run dev               # tsx watch, hot reload — NODE_ENV=development
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
| `npm run dev` | Chạy dev (tsx watch, hot reload) — `NODE_ENV=development` → db `market-dev` |
| `npm run build` | Biên dịch TS → `dist/` (`tsconfig.build.json`) |
| `npm start` | Chạy từ `dist/`, `NODE_ENV` lấy từ môi trường (Dockerfile đặt `production`) |
| `npm run start:prod` | Chạy thử bản build ở mode production trên máy local → db `market-pro` |
| `npm run typecheck` | `tsc --noEmit` (bao gồm cả `tests/` và `scripts/`) |
| `npm run lint` | oxlint `--fix` + prettier `--write` (dùng khi code) |
| `npm run lint:check` / `npm run format:check` | Bản chỉ kiểm tra — CI dùng cái này |
| `npm test` | Vitest + Supertest + mongodb-memory-server |
| `npm run openapi:export` | Xuất spec tĩnh ra `openapi.json` cho client codegen |
| `npm run seed` | Seed dữ liệu mẫu — **xoá sạch collection trước khi ghi** |
| `npm run seed:bulk` | Seed khối lượng lớn — **xoá sạch collection trước khi ghi** |

### Chốt an toàn của seed

Hai lệnh seed gọi `deleteMany({})` trên toàn bộ collection, nên `scripts/assertDisposableDb.ts`
chặn theo TÊN DB và HOST của `MONGO_URI`:

| DB trong URI | Kết quả |
|---|---|
| `market-pro`, `market` | **Chặn cứng** — `SEED_ALLOW_REMOTE` cũng không mở được |
| `market-dev` | Chạy thẳng, dù host là Atlas |
| Tên khác + host `localhost` / `127.0.0.1` / `mongo` | Chạy thẳng |
| Tên khác + host từ xa, hoặc `NODE_ENV=production` | Cần override |

Trường hợp cần override thì phải nói rõ ý định trên dòng lệnh:

```bash
SEED_ALLOW_REMOTE=yes npm run seed
```

Đặt biến đó vào file `.env*` là vô hiệu hoá chốt vĩnh viễn — đừng làm.

## Môi trường

Config tách theo `NODE_ENV`. `src/config/env.ts` nạp lần lượt, dotenv **không** ghi đè biến đã
có, nên thứ tự nạp chính là thứ tự ưu tiên:

```text
biến thật (shell / secret manager) > .env.<mode>.local > .env.<mode> > .env.local > .env
```

| Lệnh | mode | File riêng | Database |
|---|---|---|---|
| `npm run dev` | `development` | `.env.development` | `market-dev` |
| `npm run start:prod` | `production` | `.env.production` | `market-pro` |
| `npm test` | `test` | — | `mongodb-memory-server` |

`NODE_ENV` chỉ đến từ lệnh chạy (`cross-env` trong `package.json`) hoặc secret manager, **không**
từ file `.env*`: chính nó chọn file nào được nạp, nên để file tự khai là vòng tròn. Nếu một file
`.env*` khai `NODE_ENV` khác mode đang chạy, `env.ts` thoát ngay thay vì chạy với danh tính sai.

`.env` giữ phần dùng chung và không phải secret (`PORT`, `API_PREFIX`, TTL token). `MONGO_URI` và
`JWT_SECRET` nằm ở file từng môi trường — đó là hai thứ phân biệt dev với production. Mọi file
`.env*` đều gitignore, chỉ `*.example` được commit.

Production thật đặt biến qua secret manager của nơi deploy, không mang `.env.production` lên
server: chung một bộ secret nghĩa là token ký ở máy dev hợp lệ thật trên production.

`docker-compose.yml` là stack local. Nó nạp `env_file: [.env, .env.development]`, mà thứ tự ưu
tiên của Docker là `environment` > `env_file` > `ENV` của Dockerfile — nên `env_file` sẽ nuốt mất
`ENV NODE_ENV=production` trong image. Vì vậy compose khai `NODE_ENV` tường minh, và deploy thật
thì đừng dùng lại file compose này kèm `env_file`.

## Cấu trúc

```
src/
├── config/        env, database, logger (winston), redis, openapi
├── features/      auth, user, listing (core) + category, chat, upload, search, review, notification (skeleton)
│   └── <feature>/ <feature>.{model,repository,service,controller,routes,schema,types}.ts
├── middlewares/   auth, error, notFound, rateLimiter, validate, upload
├── common/        errors, utils, constants, types
├── sockets/       socket.io (chat)
├── jobs/          BullMQ (expire listing...) — hiện là skeleton
├── app.ts         khởi tạo express
└── server.ts      entrypoint
tests/
├── unit/          hàm thuần
└── integration/   đi qua HTTP bằng Supertest
```

## Trạng thái module

| Module | Trạng thái | Endpoint gốc |
|---|---|---|
| auth | ✅ Core | `POST /auth/{register,login,refresh}` |
| user | ✅ Core | `GET/PATCH/DELETE /users/me`, `GET /users/:id` |
| listing | ✅ Core | `GET /listings`, `GET /listings/nearby`, `GET/POST/PATCH/DELETE /listings/:id` |
| notification | ✅ Core | `GET/POST /notifications`, `PATCH /notifications/:id/read` |
| chain | ✅ Core | `GET /chains/:chainId/{stats,organizations}`, `POST /chains/:chainId/notifications` |
| platform-admin | ✅ Core | `POST /platform-admin/{auth/login,chains}`, `PATCH /platform-admin/organizations/:id/{chain,status}` |
| organization | ✅ Core (không có route riêng) | Ghi qua `POST /auth/register`, đọc qua chain & platform-admin |
| category | 🚧 Skeleton (501) | `/categories` |
| chat | 🚧 Skeleton (501) | `/chats` (realtime đã chạy qua socket) |
| upload | 🚧 Skeleton (501) | `/uploads` |
| search | 🚧 Skeleton (501) | `/search` |
| review | 🚧 Skeleton (501) | `/reviews` |

> Module skeleton trả `501 Not Implemented` kèm ghi chú TODO trong `*.routes.ts` để triển khai tiếp.
> Chúng **không** có `registerPath` nên không nằm trong OpenAPI spec — danh sách được ghi vào
> `info.description` của spec để client biết là "chưa có" thay vì "spec thiếu".
> Khi làm module `upload` cần cài lại `@aws-sdk/client-s3`; module job cần `bullmq`
> (đã gỡ khỏi `package.json` vì chưa dùng tới).

## OpenAPI cho client codegen

Spec là code-first từ Zod (`@asteasolutions/zod-to-openapi`) — một schema dùng cho cả validate
runtime và sinh spec, nên không có đường để spec lệch với validation.

| Cách lấy | Dùng khi |
|---|---|
| `GET /openapi.json` (server đang chạy) | Xem nhanh, hoặc codegen trỏ thẳng vào URL |
| `GET /docs` | Scalar API Reference (UI đọc tay) |
| `npm run openapi:export` → `openapi.json` | Codegen ở repo client **không cần bật server** |

**Hợp đồng với client:** mọi `registerPath` phải có `operationId` — đó là tên hàm sau codegen.
`openapi:export` fail (exit 1) nếu có operation thiếu `operationId` hoặc bị trùng, nên lỗi này
không thể lọt sang phía client.

`servers` chỉ là `API_PREFIX` (`/api/v1`) — không chứa host. Client tự set base URL; app mobile
chạy trên thiết bị thật phải dùng IP LAN, không phải `localhost`.

Script cần `.env` hợp lệ vì `src/config/env.ts` validate env lúc import (thiếu `MONGO_URI` /
`JWT_SECRET` là `process.exit(1)`), nhưng **không** kết nối MongoDB.

## Ghi chú thiết kế
- **Listing**: `status` (draft/pending/active/sold/expired/rejected/hidden), `location` GeoJSON + `2dsphere` (tìm gần), `images: string[]` (URL, ảnh thật ở S3/Cloudinary), `expiresAt` TTL index (tự hết hạn), text index (title+description), compound index `(category, status, createdAt)`.
- **Visibility**: endpoint public chỉ trả tin có status trong `PUBLIC_LISTING_STATUSES`
  (`active`, `sold`, `expired`). Client không được tự truyền `?status=`.
- **Soft delete**: `deletedAt` cho user & listing. Hook `pre(/^find/)` tự loại trừ, và
  `countDocuments` phải đăng ký hook riêng (regex `/^find/` không khớp).
- **Response chuẩn**: `{ success, message, data, meta? }`.
- **Redis là optional**: không set `REDIS_URL` thì rate limit chạy in-memory và Socket.IO
  dùng adapter in-memory → chỉ đúng khi chạy đúng 1 instance.
