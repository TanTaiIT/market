# API Contract Rules

Tài liệu này quy định các nguyên tắc bắt buộc khi thiết kế và triển khai API trong dự án. Mục tiêu là đảm bảo tính nhất quán, khả năng mở rộng và khả năng bảo trì lâu dài cho toàn bộ hệ thống API.

---

## 1. OpenAPI Specification

- Mọi endpoint mới **bắt buộc** phải được khai báo trong OpenAPI spec **trước hoặc đồng thời** với quá trình implementation. Không được triển khai endpoint khi chưa có contract tương ứng.
- File `openapi.ts` là **nguồn contract chính thức duy nhất** (single source of truth) cho toàn bộ API. Mọi tài liệu, SDK client, hoặc mock server phải được sinh ra hoặc đối chiếu từ file này.
- Pull Request bổ sung/thay đổi endpoint mà không cập nhật `openapi.ts` sẽ bị từ chối trong quá trình review.

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
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

| Field | Kiểu dữ liệu | Mô tả |
|---|---|---|
| `data` | array | Danh sách kết quả của trang hiện tại |
| `meta.page` | number | Trang hiện tại (bắt đầu từ 1) |
| `meta.limit` | number | Số lượng item tối đa trên mỗi trang |
| `meta.total` | number | Tổng số item trong toàn bộ tập dữ liệu |
| `meta.totalPages` | number | Tổng số trang, tính từ `total` và `limit` |

## 4. Error Handling

- **Không** được `throw` error một cách tự do (raw exception, string, object không chuẩn hóa...) ra ngoài tầng API.
- Mọi lỗi trả về cho client **bắt buộc** phải đi qua class `ApiError` để đảm bảo định dạng thống nhất.
- Format chuẩn của error response:

```json
{
  "code": "LISTING_NOT_FOUND",
  "message": "Listing does not exist",
  "statusCode": 404
}
```

| Field | Kiểu dữ liệu | Mô tả |
|---|---|---|
| `code` | string | Mã lỗi dạng `UPPER_SNAKE_CASE`, duy nhất và có thể tra cứu được |
| `message` | string | Thông điệp lỗi dễ hiểu, có thể hiển thị cho client/dev |
| `statusCode` | number | HTTP status code tương ứng |

---

### Ghi chú tuân thủ

Các quy tắc trên là bắt buộc (mandatory), không phải khuyến nghị. Mọi vi phạm cần được phát hiện và chặn lại ngay tại bước code review hoặc CI/CD pipeline (ví dụ: lint rule kiểm tra `ApiError`, kiểm tra diff của `openapi.ts`).