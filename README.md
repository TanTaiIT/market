# Chợ Tốt Clone — Backend

Marketplace/Classifieds API. Express + MongoDB (Mongoose) + **TypeScript**, kiến trúc
**feature-based** (`src/features/`).

- **Validation + OpenAPI**: 1 schema Zod dùng chung (validate + type + docs) — `zod-to-openapi`
- **Docs**: Scalar API Reference tại `/docs` (spec `/openapi.json`)
- **Logger**: winston (console, có timestamp; access log tự viết trong `app.ts`)
- **Auth**: JWT access + refresh
- **Realtime**: Socket.IO (chat)
- **Rate limit**: rate-limiter-flexible, đếm in-memory theo process

## Yêu cầu
- Node.js >= 20
- MongoDB (local hoặc qua `docker-compose`)

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
| `npm run migrate:v2` | Đưa dữ liệu v1 sang mô hình v2 (memberships, role_grants, gỡ chain) — idempotent |

## Hai trục kiểm duyệt (v2)

Mỗi tin thuộc ĐÚNG MỘT hàng đợi, và khoá định tuyến là `visibility` — không phải `organizationId`:

| `organizationId` | `visibility` | Hàng đợi | Ai duyệt |
|---|---|---|---|
| có | `org_internal` | org | staff nhóm con → manager org |
| có | `public` | danh mục | manager (danh mục × tỉnh) |
| `null` | `public` | danh mục | manager (danh mục × tỉnh) |
| `null` | `org_internal` | — | vô nghĩa, chặn ở validation |

Tin công khai từ một tổ chức vẫn phải qua manager danh mục: `organizationId` chỉ còn là
attribution (badge "đăng bởi trường X"). Ô (danh mục × tỉnh) chưa có ai phụ trách thì tin rơi về
hàng đợi của master — `GET /moderation/coverage` là chỗ nhìn thấy các ô đó trước khi master
chết chìm.

Quota là backpressure theo bucket: `(user, org)` cho tin nội bộ, `(user, org)` hạn mức cứng 2
cho người ngoài, `(user, danh mục)` cho trục công khai. Bị từ chối 3 lần trong 7 ngày —
**đếm xuyên trục** — thì khoá quyền đăng; đó là thứ bịt lỗ hổng "duyệt xong lại có slot, đăng
tiếp vô hạn".

## Mô hình quyền (v2)

Tài khoản là **toàn cục**: `users` không có `organizationId`, `email` unique toàn hệ thống.
Hai bảng tách bạch:

- `memberships` — **thân phận**: người này thuộc org nào, nhóm con nào (`owner | member | alumni`).
- `role_grants` — **quyền hạn**: `master | manager | staff` × scope `system | org | org_unit | category_province`.

Một giáo viên là thành viên của trường (thân phận) và **có thể có hoặc không** quyền duyệt tin.
Gộp hai thứ vào một cột thì không biểu diễn nổi trường hợp đó.

Org hoạt động của mỗi request đến từ **subdomain** hoặc header **`X-Org-Slug`** (nếu chỉ thuộc
đúng một org thì suy ra được), rồi đối chiếu với `memberships` ngay lúc đó — không nằm trong
token. Rời org là mất quyền ngay, không chờ token hết hạn.

```http
POST /api/v1/auth/login          { "email": "...", "password": "..." }
GET  /api/v1/listings            Authorization: Bearer <token>
                                 X-Org-Slug: hung-vuong
```

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
├── config/        env, database, logger (winston), openapi
├── features/      auth, user, listing (core) + category, chat, upload, search, review, notification (skeleton)
│   └── <feature>/ <feature>.{model,repository,service,controller,routes,schema,types}.ts
├── middlewares/   auth, error, notFound, rateLimiter, validate
├── common/        errors, utils, constants, types
├── sockets/       socket.io (chat)
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
| organization | ✅ Core | `GET /organizations/{lookup,slug-availability}` (public) · `POST /organizations`, `PATCH /organizations/:id/{status,slug}` (master) |
| membership | ✅ Core (không có route riêng) | Quan hệ user ↔ org; sinh ra qua duyệt đơn tham gia |
| join-request | ✅ Core | `POST /join-requests`, `GET /join-requests{,/mine}`, `PATCH /join-requests/:id/{approve,reject}`, `POST /join-requests/bulk-approve` |
| role-grant | ✅ Core | `POST /role-grants`, `GET /role-grants/mine`, `DELETE /role-grants/:id` |
| org-unit | ✅ Core | `GET/POST /org-units`, `PATCH/DELETE /org-units/:id` |
| category | 🚧 Skeleton (501) | `/categories` |
| chat | 🚧 Skeleton (501) | `/chats` (realtime đã chạy qua socket) |
| upload | 🚧 Skeleton (501) | `/uploads` |
| search | 🚧 Skeleton (501) | `/search` |
| review | 🚧 Skeleton (501) | `/reviews` |

> Module skeleton trả `501 Not Implemented` kèm ghi chú TODO trong `*.routes.ts` để triển khai tiếp.
> Chúng **không** có `registerPath` nên không nằm trong OpenAPI spec — danh sách được ghi vào
> `info.description` của spec để client biết là "chưa có" thay vì "spec thiếu".
> Khi làm module `upload` cần cài lại `multer` + `@aws-sdk/client-s3`; job nền cần `bullmq`
> và một Redis (`ioredis`). Tất cả đã gỡ khỏi `package.json` vì chưa dùng tới — hạ tầng nằm
> chờ một feature chưa có thì vẫn phải bảo trì, vẫn nằm trong image, mà không đổi lấy được gì.

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
- **Đúng MỘT instance**: rate limit đếm trong bộ nhớ process, Socket.IO dùng adapter in-memory.
  Muốn scale ra nhiều instance thì cả hai cần một store dùng chung (Redis là bản chuẩn) —
  điểm cần sửa đã ghi ngay tại `rateLimiter.middleware.ts` và `sockets/index.ts`.
