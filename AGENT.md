# AGENTS.md — Chợ Tốt Clone

## Tổng quan dự án
Nền tảng rao vặt/mua bán (giống Chợ Tốt) — Node.js + Express + MongoDB.
Đối tượng dùng: người mua/bán cá nhân, có chat, đăng tin, tìm kiếm theo vị trí.

## Stack & công cụ
- Runtime: Node.js 20+, Express 4.x
- DB: MongoDB + Mongoose
- Auth: JWT (access + refresh)
- Upload ảnh: Multer + Cloudinary
- Realtime: Socket.io
- Validation: Zod
- Test: Jest + Supertest
- Lint: ESLint + Prettier (config có sẵn trong repo, không tự đổi rule)

## Cấu trúc thư mục (BẮT BUỘC tuân theo)
src/
  modules/<feature>/
    <feature>.routes.js
    <feature>.controller.js
    <feature>.service.js
    <feature>.model.js
    <feature>.validator.js
  middlewares/
  utils/
  config/
  constants/

Khi tạo feature mới, luôn tạo đủ 5 file trên theo đúng pattern của module `product` (xem src/modules/product làm ví dụ mẫu).

## Quy tắc code (BẮT BUỘC)
1. Controller KHÔNG chứa logic nghiệp vụ — chỉ gọi service và trả response.
2. Mọi input từ client phải validate bằng Zod trước khi vào controller.
3. Mọi lỗi throw qua class `AppError` (src/utils/AppError.js), không throw string/Error thường.
4. Response luôn theo format: `{ success: boolean, data, message }`.
5. Route cần đăng nhập → dùng middleware `authenticate`; cần phân quyền → `authorize('admin'|'seller'|'user')`.
6. Không hardcode chuỗi trạng thái (`"active"`, `"pending"`...) — dùng enum trong `src/constants/status.js`.
7. Query MongoDB chỉ đọc → dùng `.lean()`. Field dùng để filter/sort phải có index.
8. Không dùng `console.log` — dùng logger ở `src/utils/logger.js`.
9. Không commit file `.env` hoặc secret.

## Testing
- Mỗi endpoint mới bắt buộc có test ở `tests/<feature>.test.js` dùng Supertest.
- Chạy `npm test` phải pass trước khi coi task hoàn thành.

## Quy trình khi generate code
1. Đọc module tương tự đã có trong repo để bám convention (không tự sáng tạo pattern mới).
2. Sau khi sửa code, chạy `npm run lint` và tự sửa lỗi lint.
3. Nếu thay đổi schema MongoDB, phải note rõ trong PR description là có cần migration không.
4. KHÔNG tự ý cài thêm package ngoài package.json hiện có — nếu cần, hỏi trước.

## Việc AI KHÔNG được tự ý làm
- Không xóa/sửa migration cũ.
- Không đổi cấu trúc response API hiện có (breaking change) nếu không được yêu cầu rõ.
- Không tắt/sửa rule ESLint để né lỗi.