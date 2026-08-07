# Multi-tenant Chain / Organization / User — báo cáo triển khai

> Bộ ba tài liệu: `multi-tenant.md` trả lời **vì sao**, file này trả lời **hiện trạng**,
> `docs/rules/multi-tenant.convention.md` trả lời **lần sau phải làm gì**.

- Phạm vi: 16/17 mục trong checklist triển khai của tài liệu nghiệp vụ.
- Quy mô: **31 file mới** (~1.6k dòng) + **29 file sửa** (+689 / −199).
- Gate: `npm run lint:check` sạch · `npm run typecheck` sạch · `npm test` **31/31 pass**.

---

## 1. Lớp cách ly tenant (thay RLS)

Ba tầng độc lập, một tầng thủng vẫn còn hai.

| Tầng | File | Vai trò |
|---|---|---|
| Middleware | `src/middlewares/tenant.middleware.ts` | Dựng scope từ nguồn đã verify, mở `AsyncLocalStorage` cho cả request |
| Repository | `src/features/*/*.repository.ts` | KHÔNG tự viết filter `organizationId` — scope đến từ context |
| Mongoose plugin | `src/common/tenant/tenantPlugin.ts` | Chèn filter ở tầng thấp nhất, **fail-closed** |

### Scope

```ts
type TenantScope = {
  ownOrgId: Types.ObjectId | null   // null chỉ khi runUnscoped
  chainOrgIds: Types.ObjectId[]
  unscopedReason?: string
}
```

- **Đọc**: `organizationId ∈ (chainReadable ? chainOrgIds : [ownOrgId])`.
- **Ghi**: LUÔN ép về `ownOrgId`, không phụ thuộc `chainReadable`, không có ngoại lệ.
- **Không có scope**: ném lỗi. Không bao giờ rơi về query toàn DB.

`chainReadable` khai báo **theo schema**, không theo route:

| Collection | `chainReadable` | Ghi chú |
|---|---|---|
| `Listing` | ✅ true | Quyết định #15/#16 — mọi user trong chain đọc được |
| `Notification` | ❌ false | Thông báo chain đi bằng fan-out, không mở quyền đọc |
| `User` | — không gắn plugin | Login phải tìm user trước khi có context → repository nhận `organizationId` tường minh ở **mọi** method |
| `Organization`, `Chain`, `PlatformAdmin` | — không gắn plugin | Nằm trên/ngoài tenant |
| `Category` | — không gắn plugin | Dùng chung toàn hệ thống (quyết định #7) |

### Lối thoát duy nhất

`runUnscoped('lý do', fn)` — tên cố tình xấu, `reason` bắt buộc. `grep -rn "runUnscoped"`
liệt kê đủ mọi chỗ có quyền chạm dữ liệu xuyên tenant. Hiện có đúng 5 call site:
seed, migration, fan-out thông báo chain, bộ đếm view, và test fixture.

### Hook được plugin bao phủ

`find` · `findOne` · `countDocuments` · `distinct` · `aggregate` · `findOneAndUpdate` ·
`findOneAndDelete` · `findOneAndReplace` · `replaceOne` · `updateOne` · `updateMany` ·
`deleteOne` · `deleteMany` · `validate` (gán `organizationId`) · `insertMany`.

`estimatedDocumentCount` bị plugin **ném lỗi** — nó đọc metadata cả collection, không
nhận filter, không có cách nào chèn tenant vào.

---

## 2. Feature mới

| Feature | File | Nội dung |
|---|---|---|
| `organization` | model · repository · service · schema · types | Đăng ký org + owner trong **transaction** với `_id` sinh trước (giải trứng-gà); cache TTL 30s cho status + `chainOrgIds` |
| `chain` | model · repository · service · controller · routes · schema · **middleware** | `requireChainOwner` mở lại scope theo chain; `GET /chains/:id/stats`, `GET /chains/:id/organizations`, `POST /chains/:id/notifications` |
| `notification` | model · repository · service · controller · schema · routes | Hết skeleton 501. Fan-out cấp chain = `insertMany` mỗi org một bản ghi |
| `platform-admin` | model · repository · service · controller · routes · **middleware** | Auth riêng, JWT `type: 'platform_admin'`, nhánh `/platform-admin/*` không qua tenant plugin, mọi hành động có audit log |

---

## 3. Feature sửa

**`User`** — thêm `organizationId` (required, `immutable`); bỏ unique toàn cục trên
`email`, thay bằng compound `{organizationId, email}` unique + `partialFilterExpression`;
`ROLES (user|admin|moderator)` → `ORG_ROLES (owner|moderator|member)`, xoá hẳn vốn cũ để
không có hai từ vựng quyền cho cùng một thứ.

**`Listing`** — gắn plugin (`chainReadable: true`); thêm snapshot `posterName` /
`posterContact`; toàn bộ index viết lại với `organizationId` làm khoá đầu tiên; slug
unique **trong org**; bỏ populate `seller` (populate xuyên org lách được cách ly).

**`auth`** — `POST /auth/register` giờ tạo Organization + owner đầu tiên;
`POST /auth/login` chạy trong phạm vi một org; JWT mang `organizationId` + `type`;
`refresh` tự mang org của nó và vẫn check status org live.

**Hạ tầng** — `docker-compose` chuyển Mongo sang single-node replica set (điều kiện bắt
buộc của transaction); `JWT_EXPIRES_IN` 7d → 15m; thêm `APP_BASE_DOMAIN`;
`scripts/migrate-tenant.ts` (idempotent); seed dựng sẵn 1 chain 2 org + 1 org độc lập.

---

## 4. Ba chỗ code lệch thiết kế

| Thiết kế | Đã ship | Vì sao |
|---|---|---|
| scope `{ organizationIds[], writable }` | `{ ownOrgId, chainOrgIds[] }` + `chainReadable` theo schema | Ghi đã luôn ép về `ownOrgId` nên cờ `writable` thành thừa; quyền đọc là thuộc tính của collection, không phải của route |
| `GET /chains/:id/listings` | **không tồn tại** | Tin cross-org đã tự có trong `GET /listings` — thêm route riêng là hai đường đọc cho cùng một dữ liệu |
| `pre('save')` gán `organizationId` | `pre('validate')` | Mongoose chạy validation TRƯỚC pre-save của plugin → `organizationId is required` nổ trước khi hook kịp gán |

---

## 5. Hai bug phát hiện khi chạy test

1. **`populate('category')` ném `MissingSchemaError`** — model `Category` chưa từng tồn
   tại (feature còn skeleton). Bug có sẵn, nghĩa là `GET /listings/:id` chưa bao giờ chạy
   được. Đã bỏ populate thay vì đẻ thêm model cho feature ngoài phạm vi.
2. **Query của Mongoose là lazy** — trả Query ra ngoài `runUnscoped()` rồi mới `await` thì
   nó chạy sau khi AsyncLocalStorage đã đóng scope → `Missing tenant context`. Chỉ dính ở
   test; code thật đã gọi `.exec()` bên trong callback. Cạm bẫy này lặp lại được, nhớ khi
   viết call site `runUnscoped` mới.

---

## 6. Breaking changes

| Endpoint | Đổi gì |
|---|---|
| `POST /auth/register` | Bắt buộc thêm `organizationName` (+ `organizationSlug` tuỳ chọn). 409 giờ là "trùng org slug", không còn là "trùng email" |
| `POST /auth/login` | Phải xác định được org: subdomain, hoặc `orgSlug` trong body. Thiếu → 401 |
| `GET /listings*` | `seller` trả về ObjectId, không còn object populate. Đọc tên/liên hệ ở `posterName` / `posterContact` |
| Mọi route nghiệp vụ | Org bị suspend → 403 ngay, không đợi access token hết hạn |
| JWT | Payload thêm `organizationId` + `type`; access token 7d → 15m. **Token cũ không dùng được** |

---

## 7. Còn tồn đọng

### 7.1 Chặn tính năng cụ thể

| # | Hạng mục | Vì sao chưa làm | Cần gì để làm |
|---|---|---|---|
| 1 | **Atlas Search cho `?q=`** | Cần cluster Atlas; `mongodb-memory-server` không chạy `$search` nên không test được ở CI | Cluster Atlas + search index definition; thay `buildFilter` regex bằng `$search` aggregation |
| 2 | **Mời user vào org sẵn có** | Cơ chế mời chưa được chốt (email invite / link / admin tạo sẵn) | Chốt UX trước, rồi thêm `POST /organizations/:id/members` |
| 3 | **Refresh token rotate/revoke** | Access token đã rút xuống 15m nhưng refresh vẫn chỉ ký lại, chưa có store | Chọn Redis hay collection; thêm rotation + revoke list |

**Mục 1 là mục duy nhất trong checklist 17 việc chưa hoàn thành.** Hiện `?q=` chạy regex
trên `title` + `description`, phạm vi quét nằm trong org — trần và đường nâng cấp đã ghi
bằng `ponytail:` ngay tại `listing.repository.buildFilter`, không phải cliff im lặng.

### 7.2 Nợ vận hành

| Hạng mục | Hiện trạng | Rủi ro nếu bỏ qua |
|---|---|---|
| Cache status org + `chainOrgIds` | In-memory TTL 30s | Chạy nhiều instance thì mỗi instance stale riêng; suspend có thể trễ tới 30s trên từng node → chuyển Redis |
| `syncIndexes()` trong migration | Rebuild toàn bộ index | Trên collection production lớn sẽ nặng → thay bằng `createIndexes`/`dropIndex` có kiểm soát, `background: true` |
| `Notification.readBy` | Mảng trong document | Đủ cho vài nghìn user/org; vượt thì tách bảng `NotificationRead` |
| Snapshot `posterName` / `posterContact` | Chụp một lần lúc tạo tin | User đổi số điện thoại thì tin cũ vẫn giữ số cũ. Cố ý (khuyến nghị của tài liệu) — thêm job resync nếu thành vấn đề thật |

### 7.3 Nghiệp vụ chưa chốt

- `Chain.status = suspended` **chưa lan xuống** org thành viên. Hiện chỉ chặn nhóm route
  `/chains/*`; org bị suspend thì bị loại khỏi `chainOrgIds`, nhưng chiều ngược lại thì chưa.
- Billing/gói dịch vụ gắn ở cấp Organization hay Chain.
- Chain moderator (vai trò trung gian chỉ xem một phần org) — hiện chỉ có đúng chain owner.
- User trong chain bấm liên hệ tin org khác: có tạo hội thoại xuyên org không, hay chỉ
  hiện `posterContact` tĩnh.
- Platform admin chưa có refresh token — 15 phút phải đăng nhập lại. Chấp nhận được vì
  nhánh này dùng thưa; đổi ý thì thêm `/platform-admin/auth/refresh`.

---

## 8. Test đang bảo vệ những gì

`tests/unit/tenantPlugin.test.ts` (10 test)
- find / countDocuments / distinct / aggregate đều bị chèn `organizationId`
- không có scope → **throw**, không trả toàn bộ document
- `chainReadable` mở rộng đọc; schema không có cờ vẫn chỉ thấy org mình
- `organizationId` client gửi lên bị bỏ qua (cả `create` lẫn `insertMany`)
- scope nhiều org KHÔNG cho update/delete lan sang org khác
- `estimatedDocumentCount` bị chặn · `runUnscoped` từ chối ghi document không mang org

`tests/integration/tenant-isolation.test.ts` (13 test)
- trùng email ở 2 org tạo được 2 tài khoản riêng
- org A không đọc/sửa/xoá được tin org B → **404**, không phải 403 (không lộ tồn tại)
- login thiếu org → 401; có `orgSlug` → đúng tài khoản của org đó
- user trong chain thấy tin mọi org cùng chain ngay trên `GET /listings`
- nhìn thấy ≠ sửa được: tin org khác vẫn 403, giá trị không đổi
- chain owner ghi tin mới thì tin rơi vào org của chính họ
- thống kê chain gộp đủ hai org; không phải chủ chain → 403
- token user KHÔNG dùng được cho route platform-admin
- thông báo chain fan-out mỗi org một bản ghi riêng
- suspend org có hiệu lực ngay, không đợi token hết hạn

---

## 9. Chạy thử

```bash
docker compose up -d mongo        # single-node replica set rs0, healthcheck tự initiate
cp .env.example .env              # MONGO_URI đã kèm ?directConnection=true cho host

npm run migrate:tenant            # data cũ: tạo org mặc định + backfill + sync index
npm run seed                      # data mới: 1 chain (hung-vuong + cao-thang) + 1 org độc lập

npm test
```

Đăng nhập thử sau khi seed:

```http
POST /api/v1/auth/login
{ "orgSlug": "hung-vuong", "email": "owner@hung-vuong.local", "password": "password123" }

POST /platform-admin/auth/login
{ "email": "admin@platform.local", "password": "platform123" }
```

`owner@hung-vuong.local` đồng thời là chain owner của `abc-edu`, dùng để thử
`GET /api/v1/chains/:chainId/stats`.
