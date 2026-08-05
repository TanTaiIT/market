Rules
Không sử dụng any.
Nếu bắt buộc dùng any, phải có comment giải thích rõ lý do và phạm vi sử dụng.
Tất cả function export phải khai báo kiểu trả về rõ ràng.
Không để TypeScript tự infer return type cho public API.
Type Definition
Dùng type cho object shape đơn giản.
Dùng interface cho các model, DTO hoặc cấu trúc có khả năng extend.

Ví dụ:

interface UserDto {
  id: string;
  email: string;
}

interface AdminUserDto extends UserDto {
  permissions: string[];
}
DTO Rules

Không trả trực tiếp database document ra API.

Không:

return listing;

Nên:

return ListingResponseDto.fromEntity(listing);

Mỗi request/response phải có DTO riêng:

CreateListingDto
UpdateListingDto
ListingResponseDto
TypeScript Config

Bắt buộc bật:

{
  "compilerOptions": {
    "strict": true
  }
}

Không disable strict để bỏ qua lỗi.