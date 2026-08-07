# Logging Rules

Tài liệu này quy định các nguyên tắc bắt buộc khi ghi log trong hệ thống, nhằm đảm bảo log có thể tra cứu, phân tích tự động, và không làm rò rỉ thông tin nhạy cảm.

---

## 1. Structured Logging

- **Không** log plain string thiếu ngữ cảnh và không thể parse tự động.

- Logger là **winston** (`src/config/logger.ts`). Chữ ký là `(message, meta)` —
  **KHÔNG phải pino** `(meta, message)`. Đảo thứ tự thì winston lấy object làm
  `message`, in ra `[object Object]` và nuốt luôn chuỗi mô tả.

  ❌ Không nên:
  ```ts
  console.log('User login')
  logger.info({ event: 'user_login', userId }, 'User login')  // pino signature
  ```

  ✅ Nên:
  ```ts
  logger.info('user_login', { userId })
  ```

- Mỗi log entry gồm:

  | Field | Mô tả |
  |---|---|
  | `message` | Tên sự kiện / mô tả ngắn, tham số **thứ nhất** |
  | `meta` | Object context ở tham số **thứ hai** (`userId`, `err`, `path`...) |
  | `level` | Mức độ log: `debug` \| `info` \| `warn` \| `error` |
  | `timestamp` | Tự động sinh bởi transport |
  | `service` | Từ `defaultMeta`, không cần truyền tay |

- Truyền `Error` qua meta (`{ err }`) — formatter đã serialize `message` + `stack`;
  `JSON.stringify` mặc định sẽ trả `{}` vì hai field đó là non-enumerable.
- Không dùng `console.log` / `console.error` trực tiếp trong code nghiệp vụ (trừ
  `scripts/`). Toàn bộ log phải đi qua module `logger` dùng chung.
- Không nuốt lỗi: `catch {}` rỗng hoặc handler `unhandledRejection` rỗng là vi phạm —
  đã từng làm server chết mà không để lại một dòng log nào.

## 2. Sensitive Information

Tuyệt đối **không được log** các loại dữ liệu nhạy cảm sau, dù ở dạng raw hay đã encode:

- Mật khẩu (`password`)
- Token xác thực (`token`, access token, refresh token, session token...)
- Số điện thoại đầy đủ (`full phone number`) — nếu cần, phải mask (ví dụ: `090****123`)
- Dữ liệu thanh toán (`payment data`): số thẻ, CVV, thông tin tài khoản ngân hàng...

Các field thuộc danh sách trên nên được đưa vào cơ chế **redaction/masking tự động** ở tầng logger, thay vì phụ thuộc hoàn toàn vào việc developer tự kiểm soát khi viết code.

## 3. Request Trace — 🚧 CHƯA TRIỂN KHAI

> Hiện tại `app.ts` mới có access log (`METHOD path status {ms}`), chưa có `requestId`.
> Mục này là mục tiêu cần làm, không phải mô tả hiện trạng — đừng viết code giả định
> `requestId` đã tồn tại.

- Mỗi request đi vào hệ thống bắt buộc phải được gán một `requestId` duy nhất (sinh mới nếu chưa có, hoặc kế thừa từ header như `x-request-id` nếu request đến từ upstream service).
- `requestId` phải được truyền xuyên suốt qua toàn bộ luồng xử lý, xuất hiện trong **mọi** log entry liên quan đến request đó:

  ```
  HTTP Request
      ↓
  Service
      ↓
  Database
      ↓
  Queue
  ```

- Mục đích: cho phép trace toàn bộ vòng đời của một request qua nhiều tầng/service chỉ bằng cách filter theo `requestId`, phục vụ debug và điều tra sự cố nhanh chóng.
- Nếu hệ thống có kiến trúc microservices hoặc dùng message queue, `requestId` phải được đính kèm trong metadata của message để duy trì khả năng trace liên-service.

---

### Ghi chú tuân thủ

Các quy tắc trên là bắt buộc. Nên bổ sung lint rule hoặc code review checklist để phát hiện các trường hợp dùng `console.log` trực tiếp hoặc log field nhạy cảm ngoài ý muốn.