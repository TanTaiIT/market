# API Contract Rules

Tài liệu này quy định các nguyên tắc bắt buộc khi thiết kế và triển khai API trong dự án. Mục tiêu là đảm bảo tính nhất quán, khả năng mở rộng và khả năng bảo trì lâu dài cho toàn bộ hệ thống API.

---

## 1. OpenAPI Specification

- Spec là **code-first**: sinh từ Zod schema qua `@asteasolutions/zod-to-openapi`, không có file YAML/JSON viết tay.
  - Component schema đăng ký trong `src/features/<feature>/<feature>.schema.ts` bằng `registry.register(...)`.
  - Endpoint đăng ký trong `src/features/<feature>/<feature>.routes.ts` bằng `registry.registerPath(...)`, đặt ngay dưới phần khai báo route.
  - `src/config/openapi.ts` giữ registry + helper dùng chung (`envelope`, `jsonResponse`, `errorResponse`, `paginationMetaSchema`).
- Mọi endpoint mới **bắt buộc** có `registerPath` tương ứng. Thiếu `registerPath` thì endpoint không xuất hiện ở `/docs` — bug này từng làm `/docs` trống hoàn toàn dù đã cài đủ Scalar + zod-to-openapi.
- Spec phục vụ tại `/openapi.json`, UI tại `/docs`.

## 2. Versioning

- Tất cả API đều phải có version rõ ràng trong đường dẫn:
  ```
  /api/v1/...
  ```
- **Không được thay đổi** cấu trúc hoặc ý nghĩa của các response field đã public (đã release cho client sử dụng), bao gồm:
  - Đổi tên field
  - Đổi kiểu dữ liệu
  - Xóa field
  - Thay đổi ý nghĩa/logic của field
- Nếu có **breaking change**, bắt buộc phải phát hành version mới:
  ```
  /api/v2/...
  ```
  Version cũ (`v1`) vẫn phải được duy trì hoạt động cho đến khi có thông báo deprecation chính thức và thời gian chuyển tiếp phù hợp.

## 3. Pagination

Mọi API trả về danh sách (list) đều phải tuân theo format response thống nhất sau:

```json
{
  "success": true,
  "message": "Listings",
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5,
    "hasNextPage": true,
    "hasPrevPage": false
  }
}
```

| Field | Kiểu dữ liệu | Mô tả |
|---|---|---|
| `success` | boolean | Luôn `true` với response thành công |
| `message` | string | Mô tả ngắn cho client/dev |
| `data` | array | Danh sách kết quả của trang hiện tại |
| `meta.page` | number | Trang hiện tại (bắt đầu từ 1) |
| `meta.limit` | number | Số lượng item tối đa trên mỗi trang |
| `meta.total` | number | Tổng số item trong toàn bộ tập dữ liệu |
| `meta.totalPages` | number | Tổng số trang, tính từ `total` và `limit` |
| `meta.hasNextPage` / `meta.hasPrevPage` | boolean | Tiện cho client phân trang |

`meta` sinh bằng `buildPaginationMeta()` trong `src/common/utils/pagination.ts`, tham số
phân trang chuẩn hoá bằng `parsePagination()`. **`total` phải đếm cùng điều kiện với
`data`** — chú ý hook soft-delete không tự áp cho `countDocuments`.

## 4. Error Handling

- **Không** được `throw` error một cách tự do (raw exception, string, object không chuẩn hóa...) ra ngoài tầng API.
- Mọi lỗi trả về cho client **bắt buộc** phải đi qua class `ApiError` để đảm bảo định dạng thống nhất.
- Format chuẩn của error response:

```json
{
  "success": false,
  "message": "Listing not found",
  "details": [{ "path": "price", "message": "Expected number, received string" }]
}
```

| Field | Kiểu dữ liệu | Mô tả |
|---|---|---|
| `success` | boolean | Luôn `false` |
| `message` | string | Thông điệp lỗi dễ hiểu, có thể hiển thị cho client/dev |
| `details` | array? | Chỉ có với lỗi validation — danh sách `{ path, message }` từ Zod |
| `stack` | string? | **Chỉ ở môi trường dev**, không bao giờ xuất hiện ở production |

HTTP status code nằm ở response status, **không lặp lại trong body**. Zod schema của
error body: `errorResponseSchema` trong `src/config/openapi.ts`.

> Chưa có field `code` dạng `UPPER_SNAKE_CASE`. Nếu client cần phân biệt lỗi theo mã
> thay vì theo `message`, phải thêm vào `ApiError` + `errorResponseSchema` cùng lúc.

---

### Ghi chú tuân thủ

Các quy tắc trên là bắt buộc (mandatory), không phải khuyến nghị. Mọi vi phạm cần được phát hiện và chặn lại ngay tại bước code review hoặc CI/CD pipeline.