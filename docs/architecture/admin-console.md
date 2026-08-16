# Thiết kế dữ liệu cho Bàn quản trị (admin console)

> ⚠️ **ĐÃ LỖI THỜI kể từ v2** — mô tả mô hình v1 (chain, 1 user ↔ 1 org, nhánh
> platform-admin). Riêng `Chain.features.crossOrgChat` không còn tồn tại; công tắc chat xuyên org chưa có bản thay thế. Trạng thái đích: `v2-org-permission.plan.md`.

> Bộ ba tài liệu multi-tenant trả lời *vì sao / hiện trạng / lần sau phải làm gì*. File này
> hẹp hơn: **UI bàn quản trị cần dữ liệu gì, và schema hiện tại phải đổi thế nào để đỡ được.**
>
> Nguồn UI: prototype `ghim-admin-ui.html` (9 màn) + bản port React Native ở `docs/VueRoute`.
> Ràng buộc bắt buộc: `docs/rules/multi-tenant.convention.md` — mọi mục dưới đây đã bám §0–§9.

---

## 0. Kết luận ngắn

- **4 collection mới**: `Category`, `OrganizationCategory`, `Report`, `AuditLog`.
- **5 collection sửa**: `Listing`, `Notification`, `User`, `Organization`, `Chain`.
- **3 quyết định phải chốt trước khi viết code** (§2) — hai trong số đó mâu thuẫn trực tiếp
  với quyết định kiến trúc đã ghi trong convention, nên không tự quyết được.
- **Không** thêm collection thống kê/rollup nào ở giai đoạn này (§6 giải thích vì sao).

---

## 1. Đối chiếu: màn admin → dữ liệu

| Màn | Dữ liệu cần | Đã có | Thiếu |
| --- | ----------- | ----- | ----- |
| Tổng quan · thẻ số | đếm tin chờ/đang hiển thị, số người dùng, số báo cáo mở | `Listing.status`, `User` | `Report` |
| Tổng quan · bàn duyệt | tin `pending` + lý do từ chối | `Listing.status` | `Listing.moderation` |
| Tổng quan · vừa diễn ra | dòng sự kiện có tác nhân + thời điểm | — | `AuditLog` |
| Tổng quan · biểu đồ 14 ngày | tin tạo/duyệt theo ngày | `Listing.createdAt` + index | — (aggregate) |
| Tổng quan · danh mục sôi động | đếm tin theo danh mục | `Listing.category` | `Category` (chưa tồn tại) |
| Duyệt tin | 3 tab trạng thái + duyệt nhanh | `LISTING_STATUS` | lý do + vết kiểm toán |
| Tin đăng | lọc trạng thái/danh mục, ẩn, gỡ | đủ | — |
| Danh mục | CRUD, phạm vi mở, đếm tin, trần 8 | — | `Category` + `OrganizationCategory` |
| Gửi thông báo | 3 danh nghĩa, nhóm người nhận, số người nhận | `Notification` (2 danh nghĩa) | `audience`, `reach`, nguồn `platform` |
| Người dùng | 3 trạng thái, số tin/đã bán/đánh giá | `isActive`, `rating*` | trạng thái "chờ xác thực trường" |
| Trường & hệ thống | số học sinh/tin, công tắc liên kết chain | `Organization`, `Chain` | `Chain.features` |
| Cài đặt | 3 quy tắc duyệt + 2 giới hạn | — | `Organization.settings` |

---

## 2. Ba quyết định phải chốt trước

### QĐ-1 · `Category`: dùng chung toàn hệ thống hay theo tenant?

**Xung đột.** Convention §1.3 xếp `Category` vào nhóm *không gắn `tenantPlugin`* với lý do
“dùng chung toàn hệ thống (quyết định #7), không có dữ liệu riêng của khách hàng”.

Nhưng màn Danh mục của UI cho quản trị **trường**: đặt phạm vi mở (`Cả hệ thống / Hùng Vương /
Cao Thắng`), tự thêm, tự gỡ, trần **8 danh mục**, và đếm tin **theo trường**. Đó chính là dữ
liệu riêng của khách hàng.

| Lối | Cách làm | Đánh đổi |
| --- | -------- | -------- |
| **A** | Giữ global, bỏ phần phạm vi khỏi UI | Rẻ nhất, nhưng cắt một tính năng đã thiết kế |
| **B** ✅ | `Category` global (từ điển) + `OrganizationCategory` có tenant (bật/tắt, đổi tên hiển thị, thứ tự) | `Listing.category` **giữ nguyên**, không migrate tin cũ; convention §1.3 vẫn đúng nguyên văn |
| **C** | Gắn `tenantPlugin` cho `Category` | Phải sửa convention §1.3 + migrate mọi `Listing.category` sang id theo org |

**Khuyến nghị B.** Ngữ nghĩa: “Thêm danh mục cho Hùng Vương” = tạo (hoặc dùng lại) một
`Category` trong từ điển chung, rồi bật nó cho org đó. “Gỡ bỏ” = tắt cho org, **không** xoá
khỏi từ điển — nên chốt chặn *“Còn tin trong X, chuyển tin đi trước”* của UI vẫn đúng và tin
của org khác không bị ảnh hưởng.

> Dù chọn lối nào, **bước 0 vẫn là tạo model `Category`**: `listing.model.ts:78` đang
> `ref: 'Category'` mà `mongoose.model('Category')` chưa từng được gọi.

### QĐ-2 · Công tắc liên kết chain là **cờ runtime**, không phải hằng số schema

Màn Trường & hệ thống có hai công tắc: *xem tin chéo* và *nhắn tin chéo*.

Hiện `chainReadable: true` chốt cứng lúc khai schema (`listingSchema.plugin(tenantPlugin,
{ chainReadable: true })`) — tắt được duy nhất bằng deploy lại.

**Không đụng vào plugin.** Tách hai tầng, mỗi tầng trả lời một câu khác nhau:

| Tầng | Câu hỏi | Nơi khai |
| ---- | ------- | -------- |
| `chainReadable` | Collection này **được phép** chia sẻ trong chain không? | schema (giữ nguyên) |
| `Chain.features.crossOrgListings` | Chain **này** có đang chia sẻ không? | dữ liệu, quản trị bật/tắt |

Điểm chèn duy nhất là chỗ đã tính sẵn `chainOrgIds` trong
[`tenant.middleware.ts`](../../src/middlewares/tenant.middleware.ts) — cờ tắt thì
`chainOrgIds = [org._id]`, plugin không cần biết gì thêm. Convention §1.2 vẫn nguyên vẹn.

### QĐ-3 · Cài đặt duyệt tin nhúng vào `Organization`, không tạo collection riêng

Quan hệ 1–1 với org, đọc ở mọi lần tạo tin. `resolveTenant` **đã** đọc `Organization` mỗi
request rồi, nên nhúng vào đó là 0 query thêm; tách collection riêng là +1 round-trip mỗi
request để đổi lấy đúng một document.

Kèm theo: `OrgSummary` (thứ repository trả về) hiện chỉ có `_id` + `chainId` — phải mở rộng
để mang `settings`, nếu không service vẫn phải tự query lại.

---

## 3. Collection mới

### 3.1 `Category` — **không** `tenantPlugin` (theo §1.3)

```ts
{
  name: string          // 'Sách vở'
  slug: string          // 'sach-vo'  — unique toàn cục
  icon?: string
  parentId: ObjectId | null   // cây parent-child, TODO(category) đã ghi trong route skeleton
  deletedAt: Date | null
}
```

| Index | Lý do |
| ----- | ----- |
| `{ slug: 1 }` unique, `partialFilterExpression: { deletedAt: null }` | Từ điển chung, slug là khoá tra cứu |
| `{ parentId: 1 }` | Dựng cây |

Không có `organizationId` → **không** prefix theo §0.6, và đó là lý do nó phải nằm trong danh
sách miễn trừ của §1.3 chứ không được tự ý thêm.

### 3.2 `OrganizationCategory` — `tenantPlugin`, `chainReadable: false`

Cái mà màn Danh mục thực sự đọc/ghi.

```ts
{
  organizationId: ObjectId    // plugin gán
  categoryId: ObjectId        // ref Category
  displayName?: string        // đổi tên hiển thị riêng cho org, rỗng = lấy Category.name
  enabled: boolean
  order: number
  deletedAt: Date | null
}
```

`chainReadable: false`: danh mục org A bật không phải việc của học sinh org B — câu hỏi kiểm
tra của §1.2 trả lời “không”.

| Index | Lý do |
| ----- | ----- |
| `{ organizationId: 1, categoryId: 1 }` unique + `{ deletedAt: null }` | Một org bật một danh mục đúng một lần |
| `{ organizationId: 1, enabled: 1, order: 1 }` | Đúng truy vấn của màn Danh mục và của chip lọc bên app người dùng |

Trần 8 danh mục là **luật nghiệp vụ**, ép ở service (`countDocuments` trong scope), không ép
bằng index.

### 3.3 `Report` — `tenantPlugin`, `chainReadable: false`

```ts
{
  organizationId: ObjectId
  targetType: 'listing' | 'user'      // đa hình: UI báo cáo cả tin lẫn người
  targetId: ObjectId
  targetTitle: string                  // SNAPSHOT — xem ghi chú dưới
  kind: ReportKind                     // 'scam' | 'wrong_info' | 'harassment' | 'banned_item' | 'other'
  quote: string                        // lời người báo cáo, maxlength 1000
  reporterId: ObjectId
  reporterName: string                 // snapshot
  status: 'open' | 'resolved' | 'dismissed'
  resolution?: { action: 'hide_target' | 'ignore', byUserId: ObjectId, at: Date }
  createdAt / updatedAt
}
```

**Vì sao snapshot `targetTitle`/`reporterName`**: §2.3 cấm `populate` sang `User` (không có
plugin). Tin bị gỡ rồi thì báo cáo vẫn phải đọc được — đó là hồ sơ xử lý, không phải một cái
link. Cùng lý do với `Listing.posterName`.

**Vì sao không có field `count`**: UI hiện *“3 lượt báo cáo”* = số người cùng báo cáo một đối
tượng. Đó là `$group` theo `targetId` lúc đọc, không phải counter denormalize — counter sẽ
lệch ngay lần đầu có người rút báo cáo hoặc admin gộp nhầm.

| Index | Lý do |
| ----- | ----- |
| `{ organizationId: 1, status: 1, createdAt: -1 }` | Hàng đợi báo cáo mở, mới nhất trước |
| `{ organizationId: 1, targetType: 1, targetId: 1 }` | Gom nhóm “N lượt báo cáo” + chặn một người báo cáo hai lần |

### 3.4 `AuditLog` — `tenantPlugin`, `chainReadable: false`

Panel *“Vừa diễn ra”* nhìn như tính năng trang trí, nhưng nó là **vết kiểm toán của thao tác
kiểm duyệt**: ai gỡ tin của ai, lúc nào, vì sao. Không có nó thì tranh chấp “tin tôi bị gỡ oan”
không có gì để đối chiếu.

```ts
{
  organizationId: ObjectId
  actorId: ObjectId | null       // null = hệ thống (job hết hạn tin)
  actorName: string              // snapshot
  action: AuditAction            // 'listing.approve' | 'listing.reject' | 'listing.hide'
                                 // | 'listing.remove' | 'user.verify' | 'user.lock'
                                 // | 'notice.send' | 'category.add' | 'category.remove'
                                 // | 'settings.update' | 'chain.link.toggle'
  targetType?: 'listing' | 'user' | 'category' | 'organization'
  targetId?: ObjectId
  summary: string                // câu hiển thị thẳng lên UI, đã dựng sẵn lúc ghi
  meta?: Record<string, unknown> // lý do từ chối, giá trị trước/sau…
  createdAt
}
```

| Index | Lý do |
| ----- | ----- |
| `{ organizationId: 1, createdAt: -1 }` | Đúng truy vấn duy nhất của panel |
| `{ createdAt: 1 }` TTL `expireAfterSeconds: 180 ngày` | Log tăng vô hạn. TTL **bắt buộc single-field** (§3) |

> Giữ 180 ngày là con số phải chốt với bên nghiệp vụ — nếu có yêu cầu lưu trữ dài hơn thì bỏ
> TTL và chuyển sang archive định kỳ, đừng nới TTL rồi quên.

---

## 4. Sửa collection có sẵn

### 4.1 `Listing` — thêm khối `moderation`

```ts
moderation: {
  reason?: string          // lý do từ chối, hiện thẳng cho người đăng
  byUserId?: ObjectId
  byName?: string          // snapshot
  at?: Date
}
```

Không thêm status mới: `LISTING_STATUS` đã có đủ `pending / active / rejected / hidden`, và
`PUBLIC_LISTING_STATUSES` đã chặn đúng bốn trạng thái nội bộ. `live` của UI = `active`.

Index hiện có `{ organizationId, status, createdAt }` đỡ trọn màn Duyệt tin — **không cần
thêm index nào**.

### 4.2 `Notification` — thêm nhóm người nhận + số người nhận

```ts
audience: 'organization' | 'chain' | 'sellers'   // khớp 3 viên chọn của UI
reach: number                                     // SỐ CHỐT lúc gửi, không tính lại
```

Và `NOTIFICATION_SOURCE` thêm `PLATFORM: 'platform'` cho danh nghĩa *“Từ Ghim”* — hiện chỉ có
`ORGANIZATION` và `CHAIN`.

**Vì sao `reach` chốt cứng**: đây là con số hiển thị cho người vừa bấm gửi (“đã gửi tới 1.284
người”). Tính lại sau một tháng sẽ ra số khác vì người đã vào/ra org — mà lịch sử gửi thì phải
bất biến.

Cơ chế fan-out mỗi org một bản ghi (`chainReadable: false`) **giữ nguyên** — nó đang đúng và
là lý do trạng thái đã đọc tách được theo org.

### 4.3 `User` — tách “khoá tài khoản” khỏi “chờ xác thực trường”

UI có ba trạng thái, schema hiện có hai cờ **không** ánh xạ 1–1 vào chúng:

| UI | Ánh xạ |
| -- | ------ |
| Đang khoá | `!isActive` — đã có |
| Chờ xác thực | `isEmailVerified` **không phải** thứ này. UI đang hỏi *“người này có đúng là học sinh trường không”* |
| Bình thường | còn lại |

```ts
membership: {
  status: 'pending' | 'approved'    // mặc định 'pending' với người tự đăng ký
  approvedBy?: ObjectId
  approvedAt?: Date
}
```

Giữ `isEmailVerified` nguyên nghĩa cũ (xác thực email), giữ `isActive` làm khoá. Gộp ba thứ
vào một enum sẽ mất khả năng biểu diễn “đã xác thực trường nhưng đang bị khoá”.

Index thêm: `{ organizationId: 1, 'membership.status': 1 }` cho tab *Chờ xác thực*.

**Không** thêm `postCount`/`soldCount` — xem §6.

### 4.4 `Organization` — nhúng `settings`

```ts
settings: {
  requireReview: boolean       // 'Duyệt trước khi lên bảng'   default true
  autoApproveTrusted: boolean  // 'Tự duyệt cho người bán uy tín' default true
  blockKeywords: boolean       // 'Chặn tin có từ khoá cấm'    default true
  blockedKeywords: string[]    // danh sách thật, UI hiện chưa có màn nhập
  maxActiveListingsPerUser: number   // default 10
  listingExpiryDays: 30 | 45 | 60    // default 45
}
```

`autoApproveTrusted` cần định nghĩa “uy tín” — UI ghi *“từ 5 giao dịch thành công và chưa từng
bị báo cáo”*. Vế đầu cần `soldCount` (chưa có), vế sau cần đếm `Report` theo `targetId`. Đây là
**quy tắc chưa triển khai được trọn vẹn**, nên bật cờ này phải kèm định nghĩa cụ thể chứ không
để service tự đoán.

### 4.5 `Chain` — thêm `features`

```ts
features: {
  crossOrgListings: boolean    // default true (giữ đúng hành vi hiện tại)
  crossOrgChat: boolean        // default false
}
```

`crossOrgChat` chưa có gì tiêu thụ — module chat còn 501 và socket hiện đã khoá phòng theo
`organizationId`. Thêm field bây giờ chỉ để công tắc UI có chỗ ghi; **đừng** viết code đọc nó
cho tới khi chat module tồn tại, nếu không lại thành một cờ ghi-mà-không-đọc.

---

## 5. Bảng tổng hợp `chainReadable`

| Collection | plugin | `chainReadable` | Trả lời cho câu hỏi §1.2 |
| ---------- | ------ | --------------- | ------------------------ |
| `Listing` | ✅ | **true** (giữ) | Có — học sinh xem tin chéo trường |
| `Notification` | ✅ | false (giữ) | Không — fan-out mỗi org một bản |
| `OrganizationCategory` | ✅ | **false** | Không — danh mục org A không phải việc của org B |
| `Report` | ✅ | **false** | Không — báo cáo là hồ sơ nội bộ của org sở tại |
| `AuditLog` | ✅ | **false** | Không — vết kiểm toán không rời org |
| `Category` | ❌ | — | Từ điển chung, không mang dữ liệu khách hàng (§1.3) |

---

## 6. Cái gì tính lúc đọc, cái gì chốt vào document

Nguyên tắc: **chỉ denormalize khi giá trị phải bất biến, hoặc khi đo được là chậm.** Ở quy mô
một trường (vài trăm học sinh, vài nghìn tin) mọi con số dưới đây tính lúc đọc đều rẻ.

| Con số | Cách lấy | Vì sao không denormalize |
| ------ | -------- | ------------------------ |
| Thẻ số chờ duyệt / đang hiển thị | `countDocuments` theo index `{orgId, status, createdAt}` | Đổi mỗi lần duyệt; counter sẽ lệch sau lần đầu có lỗi giữa chừng |
| Số tin / đã bán của mỗi người dùng | một `$group` theo `seller` trên index `{orgId, seller, status, createdAt}` | Cùng lý do; bảng chỉ hiện 20 dòng một trang |
| Đếm tin theo danh mục | `$group` theo `category` | Cùng lý do |
| Biểu đồ 14 ngày | `$group` theo ngày của `createdAt` | Chỉ chạy khi mở màn tổng quan |
| “N lượt báo cáo” | `$group` theo `targetId` | Người rút báo cáo là counter lệch |
| **`Notification.reach`** | **chốt lúc gửi** | Lịch sử gửi phải bất biến |
| **`Report.targetTitle`, `AuditLog.actorName`** | **snapshot lúc ghi** | §2.3 cấm populate; đối tượng có thể đã bị xoá |

Ngưỡng xét lại: khi một org vượt ~50k tin hoặc màn tổng quan vượt 300ms, thêm collection
rollup theo ngày — **đừng** thêm counter rải rác vào từng document.

---

## 7. Thứ tự triển khai

| Bước | Nội dung | Chặn cái gì |
| ---- | -------- | ----------- |
| 1 | `Category` model + seed 4 danh mục hiện hành + mở `GET /categories` (đang 501) | App người dùng: chip lọc danh mục đang luôn rỗng, `POST /listings` không có `categoryId` hợp lệ để gửi |
| 2 | `Organization.settings` + `Chain.features` + mở rộng `OrgSummary` | Màn Cài đặt, màn Trường |
| 3 | `Listing.moderation` + `AuditLog` | Màn Duyệt tin, panel Vừa diễn ra |
| 4 | `Report` | Màn Báo cáo, thẻ số “Báo cáo mở” |
| 5 | `OrganizationCategory` | Màn Danh mục (phần phạm vi) |
| 6 | `Notification.audience/reach` + `NOTIFICATION_SOURCE.PLATFORM` | Màn Gửi thông báo |
| 7 | `User.membership` | Màn Người dùng (tab Chờ xác thực) |

Bước 1 đứng đầu vì nó đang chặn **app người dùng**, không riêng bàn quản trị.

---

## 8. Migration

| Thay đổi | Cần migrate? |
| -------- | ------------ |
| Collection mới (4 cái) | Không — chỉ tạo index |
| `Listing.moderation` | Không — optional, tin cũ không có là đúng |
| `Notification.audience/reach` | Có, backfill nhẹ: `audience = sourceType === 'chain' ? 'chain' : 'organization'`, `reach = 0` (không bịa số cũ) |
| `User.membership` | **Có** — mọi user đang tồn tại phải là `approved`, nếu không toàn bộ người dùng cũ rơi vào tab “Chờ xác thực” |
| `Organization.settings`, `Chain.features` | Không — mongoose áp default khi đọc; ghi lại lúc lưu lần đầu |

Backfill viết trong `scripts/migrate-tenant.ts` theo mẫu sẵn có, bọc `runUnscoped('lý do cụ
thể', …)` đúng §6 — nhớ `.exec()` **bên trong** callback.

---

## 9. Checklist trước khi mở PR cho từng bước

Lấy nguyên §9 của `docs/rules/multi-tenant.convention.md`, cộng thêm:

- [ ] Đã chốt QĐ-1 (phạm vi `Category`) bằng văn bản — không tự chọn giữa lúc code
- [ ] `chainReadable` mới nào cũng `false` trừ khi PR nêu lý do nghiệp vụ
- [ ] Snapshot field (`targetTitle`, `actorName`) có, và **không** có `populate` sang `User`
- [ ] Test cách ly §8: org A không đọc được `Report`/`AuditLog` của org B → **404**
- [ ] `AuditLog` có TTL index single-field
