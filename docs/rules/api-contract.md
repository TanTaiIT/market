API Contract Rules
OpenAPI

Mọi endpoint mới phải được khai báo trong OpenAPI spec trước hoặc đồng thời với implementation.

Sử dụng file:

openapi.ts

làm nguồn contract chính.

Versioning

Tất cả API phải có version:

/api/v1/...

Không thay đổi response field đã public.

Nếu breaking change:

/api/v2/...
Pagination

Mọi API list phải trả format:

{
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
Error Handling

Không throw error tự do.

Mọi lỗi phải đi qua:

ApiError

Format:

{
  "code": "LISTING_NOT_FOUND",
  "message": "Listing does not exist",
  "statusCode": 404
}