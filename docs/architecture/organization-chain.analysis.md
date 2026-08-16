# Organization & Chain — phân tích hiện trạng (đọc từ code)

> ⚠️ **ĐÃ LỖI THỜI kể từ v2 (2026-08-16)** — đây là ảnh chụp hiện trạng TRƯỚC v2, giữ lại để
> đối chiếu. Những phần nay đã sai:
>
> - `chain` (§2, §3, §5.2, §5.3, §10.1) — đã gỡ hẳn.
> - `users.organizationId` + `ORG_ROLES` (§2.1, §5, §7) — tài khoản nay là toàn cục; thân phận
>   ở `memberships`, quyền hạn ở `role_grants`.
> - Nhánh `platform-admin` (§6.6, §7, §10.7) — đã xoá, `master` là một grant scope `system`.
> - §10.8 "duyệt tin ẩn danh phụ thuộc subdomain" — đã sửa: khách đọc được tin công khai đã duyệt
>   mà không cần org.
>
> Phần còn đúng: cơ chế `tenantPlugin` fail-closed và cách đọc `runUnscoped`.
> Trạng thái đích → `v2-org-permission.plan.md`.

> **Vị trí trong bộ tài liệu**: `multi-tenant.md` = *vì sao* · `multi-tenant.implementation.md`
> = *báo cáo đợt triển khai đó* · `../rules/multi-tenant.convention.md` = *lần sau phải làm gì*
> · **file này = business + thiết kế đang thực sự chạy trong `src/` hôm nay**.
>
> Nguồn: đọc trực tiếp code, không chép lại tài liệu cũ. Chỗ nào tài liệu cũ nói khác code,
> §9 ghi rõ. Chốt tại: 2026-08-16.

---

## 1. Ba tầng thực thể

```text
          ┌───────────────────────────────────────────────┐
NGOÀI     │ PlatformAdmin        bên bán phần mềm         │  không có organizationId
tenant    │  super_admin · support                        │  JWT type='platform_admin'
          └───────────────────────────────────────────────┘
          ┌───────────────────────────────────────────────┐
TRÊN      │ Chain                nhóm nhiều Organization  │  KHÔNG phải tenant
tenant    │  ownerId → User · status                      │  không có organizationId
          └───────────────────────────────────────────────┘
          ┌───────────────────────────────────────────────┐
LÀ        │ Organization         = một tenant             │  chainId: ObjectId | null
tenant    │  slug · ownerId → User · status               │  slug = khoá định danh public
          └───────────────────────────────────────────────┘
          ┌───────────────────────────────────────────────┐
TRONG     │ User (organizationId, immutable)              │  role: owner|moderator|member
tenant    │ Listing · Notification · Report · AuditLog …  │  organizationId do plugin gán
          └───────────────────────────────────────────────┘
```

Ba khái niệm hay bị trộn, code tách rất rõ:

| | Là gì | Có phải tenant? | Quyền đến từ đâu |
|---|---|---|---|
| `Organization` | Đơn vị cách ly dữ liệu | **Có** — mọi dữ liệu nghiệp vụ mang `organizationId` | `User.role` trong org |
| `Chain` | Nhóm org để đọc tổng hợp | Không | `Chain.ownerId` (không phải role) |
| `PlatformAdmin` | Bên bán phần mềm | Không | `PlatformAdmin.role` |

---

## 2. Organization — thực thể tenant

`src/features/organization/organization.model.ts`

| Field | Kiểu | Ý nghĩa nghiệp vụ |
|---|---|---|
| `chainId` | `ObjectId \| null` | `null` = org độc lập, không thuộc chain nào |
| `name` | `string` (≤150) | Tên hiển thị |
| `slug` | `string`, **unique toàn cục** | Định danh public: subdomain / `orgSlug` khi login |
| `ownerId` | `ObjectId → User`, **unique** | Chủ org |
| `status` | `active` \| `suspended` | Khoá org |
| `deletedAt` | `Date \| null` | Soft delete |

Index: `slug` unique · `ownerId` unique · `{chainId, status}` (đỡ toàn bộ nhóm route `/chains/*`).

**Organization KHÔNG gắn `tenantPlugin`** — nó *là* tenant, không nằm trong tenant. Lối vào duy
nhất là `organization.repository`.

### 2.1 Ràng buộc nghiệp vụ đang được enforce

| Ràng buộc | Enforce ở đâu | Hệ quả nghiệp vụ |
|---|---|---|
| `slug` unique toàn hệ thống | unique index + `existsBySlug` trước khi tạo | Hai trường không thể trùng slug — slug là địa chỉ public |
| `ownerId` unique | unique index | **Một User chỉ làm chủ tối đa 1 org** |
| Org luôn có chủ | transaction tạo User + Org (§6.1) | Không tồn tại cửa sổ "org không chủ" |
| Org bị khoá là khoá ngay | `resolveTenant` đọc status **live** mỗi request | Không đợi access token hết hạn |
| Org đã khoá bị loại khỏi chain | `activeIdsByChain` lọc `status: ACTIVE` | Chain không hồi sinh org đã khoá |

### 2.2 Vòng đời

```text
POST /api/v1/auth/register ──▶ Organization(chainId=null, status=active) + owner
                                        │
     PATCH /platform-admin/organizations/:id/chain ──▶ chainId = <chain> | null
     PATCH /platform-admin/organizations/:id/status ─▶ status = active | suspended
                                        │
                              (không có đường xoá org qua API)
```

Chỉ có **một** đường tạo org: `POST /auth/register` (tự phục vụ, kèm owner đầu tiên). Không có
luồng "đăng ký vào org sẵn có" vì cơ chế mời thành viên chưa chốt — ghi rõ tại
`auth.schema.ts:5`.

---

## 3. Chain — nhóm org, không phải tenant

`src/features/chain/chain.model.ts`

| Field | Kiểu | Ý nghĩa |
|---|---|---|
| `name` | `string` (≤150) | Tên hệ thống/chuỗi |
| `slug` | `string`, **unique** | Định danh |
| `ownerId` | `ObjectId → User`, **unique** | Chain owner — vẫn là User bình thường thuộc **một org bất kỳ** |
| `status` | `active` \| `suspended` | Chỉ chặn nhóm route `/chains/*` |
| `deletedAt` | `Date \| null` | Soft delete |

**Chain KHÔNG gắn `tenantPlugin`** — nó nằm trên tenant.

### 3.1 Ba điều quyết định cách chain hành xử

1. **Quyền chain tách hẳn khỏi `role`.** `requireChainOwner` so `Chain.ownerId` với
   `req.user.id`; một `owner` của org không tự động có quyền gì ở chain, và chain owner không
   cần role đặc biệt trong org của mình (`chain.middleware.ts:15`).
2. **`ownerId` unique → một User chỉ làm chủ tối đa 1 chain.**
3. **Chain là read-only.** Không có API nào để chain ghi vào dữ liệu của org thành viên; thứ gần
   nhất là broadcast, và nó **nhân bản** notification chứ không ghi xuyên org (§6.5).

### 3.2 Vòng đời — có một lỗ hổng quản trị

```text
POST /platform-admin/chains ──▶ Chain(status=active, ownerId=<user chỉ định>)
                                        │
                       ??? không có endpoint nào đổi name/slug/status/owner
```

`chainRepository.updateById` tồn tại nhưng **không có caller nào** — đổi tên chain hay
`status: suspended` hiện chỉ làm được bằng cách sửa thẳng DB. Xem §10.1.

---

## 4. Quan hệ Organization ↔ Chain

```text
Chain 1 ──── 0..n Organization        (Organization.chainId, nullable)
Chain 1 ──── 1    User (chain owner)  (Chain.ownerId, unique)
Org   1 ──── 1    User (org owner)    (Organization.ownerId, unique)
Org   1 ──── n    User                (User.organizationId, immutable)
```

Điều **không** được enforce ở đâu cả: org của chain owner không bắt buộc phải thuộc chain họ
quản lý. Xem §10.5.

Gán/gỡ chain: `organizationService.setChain` — `chainId = null` là tách ra độc lập, dữ liệu
nghiệp vụ **không đổi** (chỉ phạm vi đọc của người khác đổi). Gán vào chain đang `suspended`
bị từ chối (`chainRepository.findActiveById` lọc `ACTIVE`).

---

## 5. Cơ chế cách ly — org/chain biến thành scope thế nào

### 5.1 Hình dạng scope

```ts
// src/common/tenant/tenantContext.ts
type TenantScope = {
  ownOrgId: ObjectId | null    // ĐÍCH của mọi thao tác GHI
  chainOrgIds: ObjectId[]      // phạm vi ĐỌC mở rộng
  unscopedReason?: string      // chỉ có trong runUnscoped
}
```

- **Đọc**: `organizationId ∈ (chainReadable ? chainOrgIds : [ownOrgId])`
- **Ghi**: luôn ép về `ownOrgId`, không phụ thuộc `chainReadable`, không có ngoại lệ
- **Không có scope**: ném lỗi, không bao giờ rơi về query toàn DB

### 5.2 `chainReadable` — ai được đọc xuyên org trong chain

Khai theo **schema**, không theo route. Hiện trạng đúng như code:

| Collection | Plugin | `chainReadable` | Nghĩa nghiệp vụ |
|---|---|---|---|
| `Listing` | ✅ | **true** | Học sinh trường A thấy tin của trường B cùng chain, ngay trên `GET /listings` |
| `Notification` | ✅ | false | Thông báo chain đi bằng fan-out, trạng thái đã đọc tách theo org |
| `Report` | ✅ | false | Báo cáo là hồ sơ nội bộ của trường sở tại |
| `AuditLog` (moderation) | ✅ | false | Vết kiểm toán không rời trường, kể cả với chain owner |
| `Conversation`/`Message` | ✅ | false | Nhìn được tin ≠ nhắn được — xem §10.9 |
| `User` | ❌ | — | Login phải tìm user trước khi có context → repository nhận `organizationId` **bắt buộc** ở mọi method |
| `Organization`, `Chain`, `PlatformAdmin` | ❌ | — | Trên/ngoài tenant |
| `Category` | ❌ | — | Từ điển dùng chung toàn hệ thống, ghi thuộc về platform admin |

### 5.3 Hai đường mở scope — khác nhau ở một điểm quan trọng

| | `resolveTenant` (mọi route nghiệp vụ) | `requireChainOwner` (chỉ `/chains/*`) |
|---|---|---|
| Nguồn org | subdomain → `orgSlug` trong body → `organizationId` trong JWT | `Chain.ownerId` khớp `req.user.id` |
| `ownOrgId` | org đã resolve | org của **chính chain owner** |
| `chainOrgIds` | org cùng chain (hoặc `[ownOrgId]` nếu độc lập) | mọi org **active** của chain |
| Ép `ownOrgId ∈ chainOrgIds`? | **Có** — bù cho cache trễ (`tenant.middleware.ts:72`) | **Không** |
| Ghi rơi về đâu | org của request | org của chain owner |

Chain route không "thoát" khỏi plugin — nó chỉ chạy với scope rộng hơn. Không service nào có
nhánh `if (isChainOwner)`; `chainService.stats` dùng lại repository nguyên xi.

### 5.4 Lối thoát duy nhất: `runUnscoped(reason, fn)`

`grep -rn "runUnscoped" src scripts` — đúng 4 call site trong code chạy thật:

| Call site | Lý do |
|---|---|
| `notification.repository.ts:16` | Fan-out thông báo chain: ghi vào N org, mỗi document tự mang `organizationId` |
| `listing.repository.ts:134` | Bộ đếm view của tin đã được scope cho phép đọc (đọc xuyên chain, ghi thì không) |
| `scripts/seed.ts` · `scripts/migrate-tenant.ts` | Chạy ngoài request |

---

## 6. Luồng nghiệp vụ

### 6.1 Đăng ký org + owner — giải vòng lặp phụ thuộc

`Organization.ownerId` cần User, `User.organizationId` cần Organization. Code **không** cho
field nullable rồi update hai bước (để lại cửa sổ org không chủ) mà sinh `_id` trước ở phía app
và bọc transaction:

```text
slugify(organizationSlug ?? organizationName) ─▶ existsBySlug? ──409─▶ ConflictError
   │
   ├─ orgId = new ObjectId(); userId = new ObjectId()
   └─ withTransaction:  User.create({_id:userId, organizationId:orgId, role:'owner'})
                        Organization.create({_id:orgId, ownerId:userId, chainId:null})
   └─ clearOrganizationCache()
```

Cần **replica set** (Atlas hoặc `docker-compose` single-node `rs0`).

### 6.2 Đăng nhập — luôn nằm trong phạm vi một org

`email` chỉ unique theo `(organizationId, email)`, nên email + password **không đủ** để xác định
user. Thứ tự resolve org (`tenant.middleware.ts:40`):

```text
subdomain (<slug>.APP_BASE_DOMAIN)  ──▶ tìm org theo slug
   └─ không có → body.orgSlug (fallback dev/demo)
        └─ không có → organizationId trong access token
             └─ không có → KHÔNG mở scope (register đi đường này)
```

Lưu ý tên field khác nhau, dễ nhầm: login gửi **`orgSlug`**, register gửi
**`organizationSlug`**. `resolveTenant` chỉ đọc `orgSlug`, nên register không bị nó chi phối.

Ràng buộc chéo ở `authenticate`: `payload.organizationId` phải khớp `scope.ownOrgId`, chặn
user org A cầm token của mình gọi vào subdomain org B. `refresh` cũng chặn đổi tenant và vẫn
kiểm tra org còn sống.

### 6.3 Request nghiệp vụ thường

```text
resolveTenant ─▶ authenticate ─▶ authorize(role) ─▶ controller ─▶ service ─▶ repository
    │                                                                          │
    └─ runWithTenant({ownOrgId, chainOrgIds}) ────────────────────────▶ tenantPlugin chèn filter
```

Thứ tự này không được đảo: scope phải mở trước khi `authenticate` so token với org.

### 6.4 Chain owner đọc tổng hợp

```text
GET /chains/:chainId/stats
  authenticate → validate → requireChainOwner(mở scope = mọi org active của chain)
    ├─ organizationRepository.listByChain(chainId)      ← MỌI org (kể cả suspended)
    ├─ listingRepository.countByOrganizations()          ← aggregate, plugin tự chèn scope
    └─ userRepository.countByOrganizations(chainOrgIds)  ← User không có plugin → truyền tay
```

Bất đối xứng ở hai dòng cuối là cố ý: `Listing` có plugin nên aggregate tự bị chèn `$match`,
còn `User` không có plugin nên repository phải nhận `orgIds` tường minh. Hệ quả không mong muốn
của dòng đầu: xem §10.2.

### 6.5 Broadcast cấp chain — fan-out, không mở quyền đọc

```text
POST /chains/:chainId/notifications
  → notificationService.createForChain(chainId, chainOrgIds, input)
  → runUnscoped('chain notification fan-out') → insertMany(mỗi org 1 bản ghi)
```

Đổi lại N bản ghi cho N org, nhưng `Notification` giữ được `chainReadable: false` và trạng thái
đã đọc tách sạch theo từng org. `sourceType: 'chain'` + `sourceChainId` chỉ để hiển thị/audit,
**không** dùng để mở quyền đọc.

### 6.6 Platform admin

```text
POST  /platform-admin/auth/login                       → JWT type='platform_admin'
POST  /platform-admin/chains                           → tạo chain + chỉ định chain owner
PATCH /platform-admin/organizations/:id/chain          → gán vào chain / tách ra (null)
PATCH /platform-admin/organizations/:id/status         → active | suspended
POST|PATCH /platform-admin/categories[/:id]            → từ điển danh mục dùng chung
```

Nhánh này **không đi qua `resolveTenant`**, và mọi hành động ghi đều để lại audit log
(`platform-admin.service.ts:13`).

---

## 7. Ma trận quyền (theo code hiện tại)

| Hành động | guest | member | moderator | owner (org) | chain owner | support | super_admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Đọc tin org mình | ✅¹ | ✅ | ✅ | ✅ | ✅ | — | — |
| Đọc tin org khác **cùng chain** | ✅¹ | ✅ | ✅ | ✅ | ✅ | — | — |
| Đọc tin org ngoài chain | ❌ | ❌ | ❌ | ❌ | ❌ | — | — |
| Đăng tin | ❌ | ✅ | ✅ | ✅ | ✅ → rơi vào org **của chính họ** | — | — |
| Sửa/xoá tin | ❌ | chỉ tin của mình | chỉ tin của mình² | chỉ tin của mình² | chỉ tin của mình | — | — |
| Bàn duyệt tin + xử lý report | ❌ | ❌ | ✅ | ✅ | ❌³ | — | — |
| Tạo notification cấp org | ❌ | ❌ | ✅ | ✅ | ❌³ | — | — |
| Mở hội thoại với người bán org khác | ❌ | ❌ | ❌ | ❌ | ❌ | — | — |
| `GET /chains/:id/stats` · `/organizations` | ❌ | ❌ | ❌ | ❌ | ✅ | — | — |
| `POST /chains/:id/notifications` | ❌ | ❌ | ❌ | ❌ | ✅ | — | — |
| Tạo chain · gán chain · khoá org · sửa category | ❌ | ❌ | ❌ | ❌ | ❌ | ❌⁴ | ✅ |

¹ `GET /listings`, `/listings/nearby`, `/listings/:id` không có middleware auth nào. Khách chỉ
đọc được khi `resolveTenant` dựng được scope từ **subdomain**; không có subdomain thì không có
scope và `tenantPlugin` ném lỗi thay vì trả dữ liệu (fail-closed). `optionalAuth` đã viết nhưng
hiện **không route nào dùng**.
² `PATCH|DELETE /listings/:id` chỉ cho `seller` của tin (`listing.service`), role không nới thêm
— moderator/owner tác động lên tin người khác qua nhánh `/moderation`.
³ Trừ khi họ đồng thời là owner/moderator trong org của chính họ — quyền chain không cộng dồn.
⁴ `support` hiện **không có endpoint nào dùng được** ngoài login — xem §10.7.

---

## 8. Bản đồ file

| Vai trò | File |
|---|---|
| Scope + AsyncLocalStorage | `src/common/tenant/tenantContext.ts` |
| Chèn filter tenant (fail-closed) | `src/common/tenant/tenantPlugin.ts` |
| Dựng scope cho request thường | `src/middlewares/tenant.middleware.ts` |
| Dựng scope cho chain owner | `src/features/chain/chain.middleware.ts` |
| Tạo org + owner, gán chain, khoá org | `src/features/organization/organization.service.ts` |
| Cache org/chain (TTL 30s) | `src/features/organization/organization.repository.ts` |
| Thống kê + broadcast chain | `src/features/chain/chain.service.ts` |
| Nhánh bên bán phần mềm | `src/features/platform-admin/*` |
| Migration data cũ → multi-tenant | `scripts/migrate-tenant.ts` |

---

## 9. Chỗ tài liệu cũ đã lệch code

| Tài liệu | Nói gì | Code thực tế |
|---|---|---|
| `multi-tenant.md` §2 | "Ghi: scope phải đúng 1 org, plugin **từ chối ghi** khi scope có > 1 org" | Plugin không đếm số org — nó luôn ghi vào `ownOrgId`. Chain owner **ghi được**, và tin rơi vào org của chính họ |
| `multi-tenant.md` §10 | Test bắt buộc: "chain owner **KHÔNG ghi được** vào bất kỳ org nào" | `tests/integration/tenant-isolation.test.ts` khẳng định điều ngược lại: "chain owner ghi tin mới thì tin rơi vào org của chính họ" |
| `multi-tenant.md` §6.3 | `runWithTenant({ organizationIds, writable: false })` | Scope thật là `{ ownOrgId, chainOrgIds }`; không có cờ `writable` (§0.0 đã ghi đè, nhưng §6.3 vẫn in code cũ) |
| `multi-tenant.implementation.md` §3 | `JWT_EXPIRES_IN` 7d → **15m** | `.env` hiện tại là **7d**; `env.ts` mặc định 15m nhưng file ghi đè |
| `multi-tenant.implementation.md` gate | "31/31 test pass" | Hiện **104 test** |
| `multi-tenant.implementation.md` §1 | "`runUnscoped` có đúng 5 call site" | 4 trong code thật (+ test fixture) |

> §0.0 của `multi-tenant.md` đã tự khai một phần các lệch này, nhưng §2/§6.3/§10 vẫn giữ nguyên
> câu chữ cũ — người đọc lướt tới đó sẽ tin nhầm.

---

## 10. Khoảng trống & rủi ro đang mở

Đây là những thứ **đọc ra từ code**, không phải wishlist.

1. **Chain không có vòng đời quản trị.** Không endpoint nào đổi `name`/`slug`/`status`/`ownerId`
   của chain; `chainRepository.updateById` là dead code. Suspend một chain phải sửa DB tay,
   và không có gì kiểm soát/audit thao tác đó.

2. **`chainService.stats` trộn hai tập org.** `breakdown` + `totals.organizations` lấy từ
   `listByChain` (gồm cả org `suspended`), còn `listings`/`users` lấy theo scope
   `activeIdsByChain` (đã loại `suspended`). Hệ quả: org bị khoá hiện ra như **org rỗng
   (0 tin, 0 user)** chứ không phải org bị khoá, và tổng số org vẫn đếm nó. Cần chốt: stats
   đếm org active hay mọi org, rồi cho hai nguồn dùng chung một tập.

3. **Organization không có route nào.** Client không đọc được hồ sơ org của chính mình (tên,
   slug, chain, status) ngoài `organizationId` trong JWT. Mọi thao tác lên org đều nằm ở nhánh
   platform-admin.

4. **Org thực tế chỉ có một người.** Không có cơ chế mời/thêm thành viên → ngoài seed và
   migration, mỗi org chỉ tồn tại đúng owner được tạo lúc register. `role: moderator|member`
   hiện chưa có đường sinh ra qua API.

5. **`requireChainOwner` không ràng buộc `ownOrgId ∈ chainOrgIds`.** Nếu org của chain owner
   không thuộc chain đó, họ vẫn đọc được toàn chain và ghi vào org nằm ngoài chain. Hiện chưa
   gây hại vì route `/chains/*` chỉ có một thao tác ghi và nó đi qua `runUnscoped`, nhưng
   ràng buộc "chain owner phải thuộc chain" chưa được khai ở đâu cả.

6. **Cache in-memory 30s.** `organizationRepository` cache status + `chainOrgIds`; clear cache
   chỉ có hiệu lực trên **instance đang chạy lệnh**. Chạy nhiều instance thì suspend org có thể
   trễ tới 30s ở các node khác. Đây là nợ vận hành đã biết, chưa trả.

7. **Role `support` chưa dùng được.** Cả 5 route ghi của platform-admin đều đòi `super_admin`,
   và nhánh này không có route đọc nào → `support` đăng nhập xong không làm được gì.

8. **Duyệt tin ẩn danh phụ thuộc hoàn toàn vào subdomain.** Ba route public của `listing`
   không có middleware auth, nên nguồn org duy nhất của khách là subdomain. Với
   `APP_BASE_DOMAIN` để trống (mặc định dev), `GET /listings` không kèm token trả **400
   `Missing tenant context for "find"`** — đúng thiết kế fail-closed, nhưng nghĩa là "xem tin
   không cần đăng nhập" chỉ chạy sau khi hạ tầng subdomain lên. Cần chốt: bật subdomain, hay
   cho phép chỉ định org bằng query param ở nhánh public.

9. **Chain suspended không lan xuống org**, và **nhìn thấy ≠ nhắn được**: `Listing` mở
   `chainReadable` nên user thấy tin trường khác, nhưng `chatService.open` chặn mở hội thoại
   xuyên org. Người dùng thấy tin rồi bấm "Nhắn tin" sẽ ăn 403 — UX cụt, đang chờ công tắc
   `Chain.features.crossOrgChat` (thiết kế ở `admin-console.md` QĐ-2, chưa implement).

---

## 11. Câu hỏi nghiệp vụ cần chốt

| Câu hỏi | Vì sao chặn | Ảnh hưởng tới |
|---|---|---|
| Suspend chain có khoá luôn org thành viên? | Hiện chỉ chặn `/chains/*` | §10.1, §10.9 |
| Stats của chain đếm org bị khoá hay không? | Hai nguồn đang lệch nhau | §10.2 |
| Billing gắn ở Organization hay Chain? | Chưa có field nào ở cả hai | Model cả hai bên |
| Có vai trò "chain moderator" (chỉ xem một phần org)? | Hiện chỉ đúng một chain owner | `chain.middleware.ts` |
| User trong chain liên hệ người bán org khác thế nào? | Chat chặn xuyên org, chỉ còn `posterContact` tĩnh | §10.9 |
| Org rời chain thì dữ liệu cũ xử lý ra sao? | `setChain(null)` không đụng dữ liệu; tin từng hiện cho cả chain nay biến mất khỏi tầm nhìn org khác | `organization.service.setChain` |
| Mời thành viên vào org sẵn có bằng cách nào? | Chưa chốt UX (email invite / link / admin tạo) | §10.4 |
