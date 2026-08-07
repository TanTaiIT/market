# AGENT.md — Chợ Tốt Clone

## Tổng quan dự án
Nền tảng rao vặt/mua bán (giống Chợ Tốt) — Node.js + Express + MongoDB.
Đối tượng dùng: người mua/bán cá nhân, có chat, đăng tin, tìm kiếm theo vị trí.

## Stack & công cụ
- Runtime: Node.js 20+, Express 4.x, **TypeScript** (không có file `.js` trong `src/`)
- DB: MongoDB + Mongoose 8
- Auth: JWT (access + refresh), hash password bằng `@node-rs/bcrypt`
- Upload ảnh: Multer (memoryStorage) → S3 *(module `upload` mới ở mức skeleton)*
- Realtime: Socket.io (+ Redis adapter khi có `REDIS_URL`)
- Validation + OpenAPI: Zod + `@asteasolutions/zod-to-openapi` (1 schema dùng cho cả hai)
- Logger: **winston** (`src/config/logger.ts`)
- Test: **Vitest** + Supertest + mongodb-memory-server
- Lint/format: **oxlint + Prettier** (KHÔNG phải ESLint — config có sẵn, không tự đổi rule)

## Cấu trúc thư mục (BẮT BUỘC tuân theo)
```
src/
  features/<feature>/
    <feature>.routes.ts       ← endpoint + middleware + registerPath cho OpenAPI
    <feature>.controller.ts
    <feature>.service.ts      ← business logic
    <feature>.repository.ts   ← toàn bộ truy vấn Mongo (nếu feature có model)
    <feature>.model.ts        ← Mongoose schema
    <feature>.schema.ts       ← Zod schema (KHÔNG đặt tên `.validator.ts`)
    <feature>.types.ts        ← DTO + hàm map document → DTO
  middlewares/
  common/{constants,errors,types,utils}/
  config/
  jobs/
  sockets/
```

Module mẫu để bám theo: **`src/features/listing`** (đủ 7 layer) và
`src/features/auth` (mẫu DTO + OpenAPI). Không có module `product`.

## Quy tắc code (BẮT BUỘC)
1. Controller KHÔNG chứa logic nghiệp vụ — chỉ gọi service và trả response.
2. Mọi input từ client phải validate bằng Zod qua `validate({ body, query, params })`
   trước khi vào controller.
3. Mọi lỗi throw qua `ApiError` hoặc subclass trong `src/common/errors/` — không throw
   string/Error thường. Handler dùng chung: `src/middlewares/error.middleware.ts`.
4. Response thành công luôn đi qua `success()`/`created()` trong
   `src/common/utils/apiResponse.ts` → `{ success, message, data, meta? }`.
5. Route cần đăng nhập → `authenticate`; cần phân quyền → `authorize(ROLES.ADMIN | ...)`.
   Route public tuỳ chọn đăng nhập → `optionalAuth`.
6. Không hardcode chuỗi trạng thái (`"active"`, `"pending"`...) — dùng const trong
   `src/common/constants/index.ts` (`LISTING_STATUS`, `LISTING_CONDITION`, `ROLES`).
7. **Endpoint public không bao giờ được trả tin ngoài `PUBLIC_LISTING_STATUSES`.**
   Filter mặc định nằm ở `buildFilter()` — đừng bỏ nó khi thêm query mới.
8. Query MongoDB chỉ đọc → cân nhắc `.lean()`. Field dùng để filter/sort phải có index.
9. Không dùng `console.log` — dùng `logger` ở `src/config/logger.ts`.
   Chữ ký là **winston**: `logger.info('message', { meta })` — KHÔNG phải pino
   (`logger.info({ meta }, 'message')` sẽ làm mất nội dung log).
10. Soft delete: model có hook `pre(/^find/)` loại `deletedAt != null`. Hook đó KHÔNG
    áp cho `countDocuments` — model nào đếm thì phải đăng ký thêm `pre('countDocuments')`.
11. Không commit file `.env` hoặc secret. `.env.example` chỉ chứa placeholder.

## Testing
- Test đặt trong `tests/unit/` (hàm thuần) hoặc `tests/integration/` (đi qua HTTP,
  dùng Supertest + mongodb-memory-server).
- Chạy `npm test` phải pass trước khi coi task hoàn thành.

## Quy trình khi generate code
1. Đọc feature tương tự đã có trong repo để bám convention (không tự sáng tạo pattern mới).
2. Sau khi sửa code, chạy `npm run lint` (tự fix + format).
3. Chạy `npm run typecheck`, có lỗi thì fix.
4. Chạy `npm test`.
5. Nếu thay đổi schema MongoDB, note rõ trong PR description là có cần migration không.
6. KHÔNG tự ý cài thêm package ngoài package.json hiện có — nếu cần, hỏi trước.

## Việc AI KHÔNG được tự ý làm
- Không xóa/sửa migration cũ.
- Không đổi cấu trúc response API hiện có (breaking change) nếu không được yêu cầu rõ.
- Không tắt/sửa rule lint để né lỗi.
- Không nới field của `PublicProfileDto` — đó là ranh giới chống rò rỉ dữ liệu user.
