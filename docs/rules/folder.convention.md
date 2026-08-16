## Sơ đồ tổng quan

```
src/
  common/          → code dùng chung toàn dự án, KHÔNG chứa business logic của 1 feature cụ thể
    constants/      → hằng số dùng chung (enum status, role, error code...)
    errors/         → ApiError.ts, index.ts — class lỗi chuẩn dùng xuyên suốt app
    tenant/         → tenantContext.ts (AsyncLocalStorage), tenantPlugin.ts (fail-closed),
                      tenant.errors.ts — lớp cách ly tenant, dưới cả repository
    types/          → type/interface dùng chung nhiều feature
    utils/          → hàm tiện ích thuần (formatDate, slugify, paginate...), KHÔNG gọi DB/API

  config/          → khởi tạo & cấu hình hạ tầng, KHÔNG chứa business logic
    database.ts     → kết nối MongoDB
    env.ts          → đọc & validate biến môi trường
    logger.ts        → khởi tạo winston
    openapi.ts        → registry OpenAPI + helper response dùng chung
    redis.ts          → kết nối Redis (optional, trả null khi không có REDIS_URL)

  features/        → MỌI business logic nằm ở đây, chia theo domain/feature
    <feature-name>/
      <feature>.routes.ts      → định nghĩa endpoint, gắn middleware, registry.registerPath
      <feature>.controller.ts  → nhận req/res, gọi service, format response — KHÔNG query DB trực tiếp
      <feature>.service.ts     → business logic, gọi repository
      <feature>.repository.ts  → toàn bộ truy vấn Mongo của feature
      <feature>.model.ts       → Mongoose schema/model của feature
      <feature>.schema.ts      → Zod schema (validate input + component OpenAPI)
      <feature>.types.ts       → DTO + hàm map document → DTO
    index.ts         → tổng hợp & export router của tất cả feature ra app.ts

  jobs/            → cron job, background job, queue consumer (BullMQ...)
    index.ts         → đăng ký & khởi động toàn bộ job khi server start

  middlewares/     → middleware dùng chung toàn app (KHÔNG đặt middleware riêng của
                     1 feature ở đây — middleware riêng feature thì để trong
                     chính thư mục feature đó)
    auth.middleware.ts
    error.middleware.ts
    notFound.middleware.ts
    rateLimiter.middleware.ts
    upload.middleware.ts
    validate.middleware.ts

  sockets/         → toàn bộ logic Socket.io (namespace, event handler)

  app.ts           → khởi tạo Express app, gắn middleware global, mount router
  server.ts        → entry point, start HTTP server

tests/             → NGANG HÀNG src/, không nằm trong src/
  unit/            → test hàm thuần (không cần DB/HTTP)
  integration/     → test đi qua HTTP bằng Supertest + mongodb-memory-server
```

## Danh sách feature hiện có (không tự ý đổi tên/gộp)

`auth`, `category`, `chat`, `join-request`, `listing`, `location`, `membership`,
`moderation`, `notification`, `org-unit`, `organization`, `report`, `review`,
`role-grant`, `search`, `trust`, `upload`, `user`

> `chain` và `platform-admin` đã bị gỡ ở v2 — quyền hệ thống giờ nằm ở `role-grant`
> (xem `docs/architecture/v2-org-permission.plan.md` §0).

## Quy tắc bắt buộc

1. **Mọi business logic mới thuộc về 1 domain cụ thể → luôn tạo/nằm trong
   `src/features/<feature-name>/`**, không đặt rải rác ở `common/` hay `utils/`.
2. **Code chỉ được đưa vào `common/`** khi được dùng bởi **từ 2 feature trở lên**.
   Nếu chỉ 1 feature dùng → để trong feature đó.
3. **`config/` chỉ chứa khởi tạo kết nối/cấu hình hạ tầng** (DB, Redis, logger,
   env, Swagger). Không viết business logic ở đây.
4. Khi tạo feature mới, đặt trong `src/features/<ten-feature>/` và tối thiểu
   phải có: `routes.ts`, `controller.ts`, `service.ts`, `schema.ts`.
   `model.ts` + `repository.ts` chỉ tạo nếu feature có schema Mongo riêng (VD:
   feature `search` có thể không cần model riêng vì dùng lại model của `listing`).
5. **Đặt tên file**: `<feature>.<layer>.ts`, toàn bộ chữ thường, phân cách
   bằng dấu chấm. Ví dụ đúng: `category.controller.ts`.
   Sai: `CategoryController.ts`, `category_controller.ts`.
6. **Middleware dùng chung nhiều route/feature** → `src/middlewares/`.
   **Middleware chỉ dùng riêng 1 feature** (VD: middleware check quyền sở hữu
   tin đăng) → đặt trong chính thư mục feature đó, đặt tên
   `<feature>.middleware.ts`.
7. **Job định kỳ hoặc xử lý bất đồng bộ liên quan tới feature nào** → vẫn tạo
   file job trong `src/jobs/`, nhưng import service từ
   `src/features/<feature>/` để tái sử dụng logic, không viết logic mới
   trong `jobs/`.
8. **File test** đặt trong `tests/unit/` (hàm thuần, không cần DB/HTTP) hoặc
   `tests/integration/` (gọi endpoint qua Supertest). Tên file: `<đối-tượng>.test.ts`.
9. **Không tạo thư mục cấp cao mới** (ngang hàng với `common`, `config`,
   `features`, `jobs`, `middlewares`, `sockets`, `tests`) nếu chưa được xác
   nhận. Nếu thấy cần, phải dừng lại và hỏi trước khi tạo.
10. **`index.ts` trong `src/features/`** chỉ dùng để gom router — không import
    trực tiếp service/model của feature con vào đây.

## Ví dụ minh họa — tạo feature "favorite" (yêu thích tin đăng) đúng convention

```
src/features/favorite/
  favorite.routes.ts
  favorite.controller.ts
  favorite.service.ts
  favorite.repository.ts
  favorite.model.ts
  favorite.schema.ts
```

`favorite.routes.ts` được import và mount vào `src/features/index.ts`.
Nếu cần kiểm tra tồn tại của listing trước khi favorite → gọi
`listing.service.ts` từ feature `listing`, KHÔNG copy logic hoặc query
trực tiếp vào model của `listing`.

## Checklist trước khi tạo file mới (AI tự kiểm tra)

- [ ] File này thuộc về 1 feature cụ thể hay dùng chung nhiều feature?
- [ ] Đã đặt đúng thư mục theo bảng trên chưa?
- [ ] Tên file có theo đúng format `<feature>.<layer>.ts` không?
- [ ] Nếu là middleware/job — đã xác định đúng phạm vi dùng chung hay riêng
      feature chưa?
- [ ] Có tạo thư mục cấp cao mới không? Nếu có → dừng và hỏi trước.