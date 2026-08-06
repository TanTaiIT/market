# TypeScript Rules

Tài liệu này quy định các nguyên tắc bắt buộc khi viết TypeScript trong dự án, nhằm đảm bảo type-safety, khả năng đọc hiểu và khả năng bảo trì lâu dài cho codebase.

---

## 1. Sử dụng kiểu `any`

- **Không** sử dụng `any` trong code.
- Nếu bắt buộc phải dùng `any` (ví dụ: tích hợp thư viện bên thứ ba thiếu type definition), **bắt buộc** phải có comment giải thích rõ:
  - Lý do vì sao không thể dùng type cụ thể hơn.
  - Phạm vi sử dụng (chỉ giới hạn ở đâu, không lan ra các phần khác).

  ```ts
  // any bắt buộc: thư viện `legacy-sdk` không có type definition,
  // chỉ dùng trong hàm parse response thô, đã validate lại ở tầng DTO bên dưới
  const rawResponse: any = legacySdk.call();
  ```

- Ưu tiên dùng `unknown` thay cho `any` khi cần một kiểu "chưa xác định" nhưng vẫn muốn ép kiểm tra type trước khi sử dụng.

## 2. Kiểu trả về của Function

- Tất cả các `function` được `export` **bắt buộc** phải khai báo kiểu trả về (return type) một cách tường minh.
- **Không** để TypeScript tự động infer return type đối với các public API (function/method được export ra ngoài module).

  ❌ Không nên:
  ```ts
  export function getUser(id: string) {
    return userRepository.findById(id);
  }
  ```

  ✅ Nên:
  ```ts
  export function getUser(id: string): Promise<UserDto | null> {
    return userRepository.findById(id);
  }
  ```

- Lý do: khai báo return type tường minh giúp phát hiện sớm các thay đổi ý ngoài ý muốn (accidental breaking change) khi refactor logic bên trong function.

## 3. Type Definition

- Dùng `type` cho các object shape đơn giản, union type, hoặc kiểu dữ liệu không cần mở rộng (extend).
- Dùng `interface` cho các model, DTO, hoặc cấu trúc dữ liệu có khả năng được extend về sau.

  ```ts
  interface UserDto {
    id: string;
    email: string;
  }

  interface AdminUserDto extends UserDto {
    permissions: string[];
  }
  ```

## 4. DTO Rules

- **Không** trả trực tiếp database document/entity ra ngoài API.

  ❌ Không nên:
  ```ts
  return listing;
  ```

  ✅ Nên:
  ```ts
  return ListingResponseDto.fromEntity(listing);
  ```

- Lý do: tránh rò rỉ field nội bộ (internal field), tách biệt schema database khỏi contract API, và cho phép thay đổi cấu trúc database mà không ảnh hưởng đến client.

- Mỗi luồng request/response phải có DTO riêng biệt, tương ứng với từng mục đích sử dụng, ví dụ:

  | DTO | Mục đích |
  |---|---|
  | `CreateListingDto` | Dữ liệu đầu vào khi tạo mới |
  | `UpdateListingDto` | Dữ liệu đầu vào khi cập nhật (thường các field là optional) |
  | `ListingResponseDto` | Dữ liệu trả về cho client |

## 5. TypeScript Config

- Bắt buộc bật `strict` mode trong `tsconfig.json`:

  ```json
  {
    "compilerOptions": {
      "strict": true
    }
  }
  ```

- **Không** được tắt (`disable`) `strict` mode, hoặc tắt các flag con của nó (`strictNullChecks`, `noImplicitAny`,...) chỉ để né lỗi biên dịch. Lỗi cần được xử lý tận gốc trong code, không phải bằng cách hạ thấp mức độ kiểm tra kiểu.

---

### Ghi chú tuân thủ

Các quy tắc trên là bắt buộc. Nên cấu hình ESLint (`@typescript-eslint/no-explicit-any`, `@typescript-eslint/explicit-function-return-type`...) để tự động phát hiện vi phạm ngay trong quá trình code review và CI/CD.