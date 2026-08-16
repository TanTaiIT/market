# v2 — Tổ chức, phân quyền & luồng đăng tin: kế hoạch triển khai

> Nguồn nghiệp vụ: bản thiết kế v2 (§1–§19). File này là **kế hoạch thi công trên code hiện có**
> (`docs/market`, Express + Mongoose), không lặp lại phần nghiệp vụ.
> Hiện trạng trước khi bắt đầu: `organization-chain.analysis.md`.

## 0. Bốn quyết định đã chốt (thay câu hỏi Q1–Q4 của thiết kế)

| # | Câu hỏi | Chốt | Hệ quả lớn nhất |
|---|---|---|---|
| Q1 | `staff` là gì | **Phạm vi hẹp hơn** (duyệt được, trong nhóm con của mình) | Lớp 5 giữ nguyên như §10 |
| Q2 | Ai tạo org | **Chỉ master** | `POST /auth/register` **thôi tạo org**; tài khoản trở thành global |
| Q3 | Tin org lên trang công khai | **Giới hạn hiển thị** | `visibility` — không phải `org_id` — là khoá định tuyến hàng đợi |
| Q4 | Org lồng nhau | Giữ `parentUnitId` trong schema, **truy vấn phẳng** ở vòng này | Không cần truy vấn cây |
| — | Feature `chain` | **Bỏ hẳn** | Xoá model/routes/middleware, `chainReadable`, `Organization.chainId` |

### 0.1 Hệ quả của Q3 — phải đọc kỹ

Thiết kế gốc (§3.1, §11) lấy `org_id IS NULL` làm ranh giới hai trục. Chọn "giới hạn hiển thị"
nghĩa là **ranh giới chuyển sang `visibility`**:

| `orgId` | `visibility` | Hàng đợi | Hiển thị sau khi duyệt |
|---|---|---|---|
| có | `org_internal` | org (staff nhóm con → manager org) | chỉ trong org |
| có | `public` | **manager danh mục** (category, province) | trang công khai, kèm badge org |
| `null` | `public` | manager danh mục | trang công khai |
| `null` | `org_internal` | — | **vô nghĩa, chặn ở validation** |

Mỗi tin vẫn thuộc **đúng một** hàng đợi (giữ được §11), nhưng `orgId` từ nay chỉ còn là
*attribution*, không còn là *axis discriminator*. Đây là cái giá đã biết của Q3.

### 0.2 Quyết định kỹ thuật kèm theo

1. **`master` là `role_grant(system)` trên một `User`, không phải collection `PlatformAdmin` riêng.**
   Thiết kế v2 chỉ có `users` + `role_grants`. Giữ hai nhánh auth song song là giữ hai từ vựng
   quyền cho cùng một thứ → Phase 3 gộp `PlatformAdmin` vào `User` + grant, bỏ `TOKEN_TYPE.PLATFORM_ADMIN`.
2. **`provinceCode` = tên tỉnh trong danh sách đóng 34 đơn vị** (`VN_PROVINCE_NAMES`), đúng thứ
   `listing.location.province` đang lưu. Không đẻ bộ mã thứ hai: hai SoT cho cùng một khái niệm
   là nguồn lệch dữ liệu, và danh sách hiện tại đã đóng + đã validate.
3. **Tài khoản trở thành global** — `users.email` unique **toàn cục** trở lại, `users.organizationId`
   bị xoá. Đây là đảo ngược có chủ ý của quyết định #2 cũ: khi 1 user thuộc n org, org không thể
   là thuộc tính của user.

---

## 1. Blast radius — cái gì vỡ khi làm

| Thay đổi | Kéo theo |
|---|---|
| `users.organizationId` bị xoá | `userRepository` (mọi method nhận `organizationId` bắt buộc), `authService.login/refresh`, JWT payload, `resolveTenant`, `authenticate`, toàn bộ test integration |
| `listings.organizationId` nullable | `tenantPlugin` (đang `required: true` + `immutable`), 6 index có prefix `organizationId`, `buildFilter`, mọi query listing |
| Bỏ chain | `chainOrgIds` trong scope, `chainReadable`, `Organization.chainId`, route `/chains/*`, `platform-admin/organizations/:id/chain`, seed, 3 test |
| `master` là User | `PlatformAdmin` model/middleware/routes, `TOKEN_TYPE`, `req.platformAdmin` |
| `visibility` quyết định hàng đợi | `listing.service`, `moderation.service`, `PUBLIC_LISTING_STATUSES` |

**Nguyên tắc thi công**: mỗi phase phải để `npm run typecheck` + `npm test` xanh trước khi sang
phase sau. Không có phase nào được để repo ở trạng thái nửa vời qua đêm.

---

## 2. Mô hình đích (Mongoose)

```text
users                 global: email unique toàn cục, KHÔNG có organizationId
memberships           (userId, orgId) unique — thân phận: member|owner|alumni
role_grants           quyền hạn: master|manager|staff × scope system|org|org_unit|category_province
organizations         + orgType, capabilities, verificationTier, provinceCode, allow*, slugNormalized
org_units             (orgId, name, moderatorId, parentUnitId) — optional
org_slug_aliases      (oldSlug → orgId) redirect 301
join_requests         (userId, orgId) unique khi pending
listings (= posts)    organizationId NULLABLE + visibility + provinceCode + unitId
audit_logs            = moderation_events, thêm queue/fromStatus/toStatus
```

Bỏ: `chains`, `platform_admins`.

---

## 2b. Tiến độ (cập nhật 2026-08-16)

| Bước | Trạng thái | Bằng chứng |
|---|---|---|
| Gỡ `chain` | ✅ xong | 41 file, 316 chỗ tham chiếu; `TenantScope.chainOrgIds` → `readableOrgIds` |
| Phase 1 — nền quyền | ✅ xong | `role_grants` + `common/authz/policy.ts` + 15 test thuần |
| Phase 2 — org + slug | ✅ xong | org v2 fields, `orgSlug` util + 10 test, `org_units`, `org_slug_aliases`, 2 route công khai |
| Phase 3 — auth + membership | ✅ xong | `users` toàn cục, `memberships`, `join_requests`, gộp `PlatformAdmin`, viết lại `resolveTenant` |
| Phase 4 — posts hai trục | ✅ xong | `dualAxis` trong tenantPlugin, `listing.routing.ts` thuần + 10 test, `two-axis.test.ts` 12 test |
| Phase 5 — quota + trust | ✅ xong | `listing.quota.ts` thuần + 10 test, 3 bucket, reject counter xuyên trục, uy tín tách trục |
| Phase 6 — màn quản trị | ✅ xong | hàng đợi trục danh mục, ma trận phủ sóng, đổi ô (reassign) |

Gate sau Phase 6: `typecheck` sạch · `oxlint` sạch · `prettier` sạch · **171 test pass** ·
`openapi:export` ra 45 path / 60 operation.

### Quyết định kỹ thuật của Phase 4-6

1. **`dualAxis` là option của `tenantPlugin`, không phải bỏ plugin khỏi `Listing`.** Bỏ plugin
   là gỡ lưới an toàn khỏi đúng collection nhạy cảm nhất. Thay vào đó: đọc thành `$or` hai vế
   (org + công khai), vế công khai lấy từ **scope** chứ không từ repository — repository quên
   một điều kiện thì tin chưa duyệt lọt ra ngoài.
2. **Ghi ở trục công khai không có tenant để ép**, nên quyền ở đó đến từ quyền sở hữu
   (`seller`) và `role_grants`. Plugin chỉ còn chặn được một thứ — ghi sang org KHÁC — và nó
   vẫn chặn.
3. **`provinceCode` chỉ bắt buộc với tin công khai.** Ở trục danh mục nó quyết định ai duyệt;
   ép cả tin nội bộ là phá lời hứa "khu vực là tuỳ chọn" đã có từ trước.
4. **Uy tín tách hai kho**: `memberships.trustLevel` (trục org) và collection `PublicTrust`
   theo (user × danh mục). Dùng chung một cột là biến 5 bài sạch trong một nhóm nhỏ thành
   quyền tự đăng ra toàn tỉnh.
5. **Người ngoài không bao giờ được tự đăng**, bất kể uy tín — uy tín kiếm ở chỗ khác không
   mua được quyền đăng thẳng vào tổ chức mình không thuộc về.
6. **Khách chưa đăng nhập đọc được tin công khai đã duyệt.** `resolveTenant` giờ luôn mở
   `publicAxis: { mode: 'approved' }`, kể cả khi không xác định được org — trước Phase 4,
   `GET /listings` ẩn danh trả 400 vì không có scope.

### Còn nợ sau Phase 6

| Hạng mục | Vì sao chưa làm |
|---|---|
| `AuditLog` chưa dual-axis | Vết kiểm toán vẫn là collection có tenant, nên thao tác trên tin trục công khai (reassign) chỉ ghi được `logger`, không vào `moderation_events`. Cần cùng cách xử lý như `Listing`. |
| Chưa có màn "2 tab" tách người ngoài | Dữ liệu đã tách (`pending_unverified` + hàng đợi `org_outsider`); còn thiếu endpoint lọc sẵn theo tab để client khỏi tự ghép. |
| Gỡ khoá quyền đăng sau khi bị chặn | Bị chặn vì 3 tin từ chối/7 ngày thì hiện phải chờ hết cửa sổ; chưa có thao tác quản trị để gỡ sớm. |
| Đường mời / roster / SSO | `joinedVia` đã chừa chỗ, nhưng ba cơ chế join của §7.4 vẫn là vòng sau. |

### Quyết định kỹ thuật phát sinh trong Phase 3

1. **Org hoạt động đến từ REQUEST, không từ token.** Thứ tự: subdomain → header `X-Org-Slug` →
   (nếu user chỉ thuộc đúng 1 org) org đó. Thuộc nhiều org mà không chỉ ra thì **không mở scope**,
   không đoán — đoán ở đây là tin lặng lẽ rơi vào hàng đợi tổ chức khác.
2. **Người ngoài org: mở scope cho GET, không mở cho ghi.** Không ném 403 ở middleware mà đơn
   giản là không mở scope → `tenantPlugin` fail-closed chặn mọi đường ghi, và những route không
   cần org (gửi đơn tham gia) vẫn chạy. Đổi lại lỗi ghi là 400 `Missing tenant context` thay vì
   403 — route nào cần thông điệp đẹp thì thêm `requireMembership`.
3. **JWT chỉ còn `sub`.** Bỏ `organizationId`/`role`/`type`: cả ba đều là trạng thái đọc theo
   request. Hệ quả: rời org hoặc bị thu hồi quyền có hiệu lực NGAY, không chờ token hết hạn.
   **Token cũ không dùng được.**
4. **Rate limit tắt trong `NODE_ENV=test`** — `authLimiter` khoá theo IP, mà test chạy hàng chục
   lượt đăng ký từ cùng một IP; không tắt thì thứ tự chạy quyết định test nào 429.
5. **`allowPublicPosts` không tồn tại** — Q3 chọn "giới hạn hiển thị" nên quyền đăng công khai
   do hàng đợi danh mục quyết định, không do org. Thêm cột đó là thêm field không ai đọc.

### Breaking changes của Phase 3

| Endpoint | Đổi gì |
|---|---|
| `POST /auth/register` | Chỉ tạo tài khoản. Bỏ `organizationName`/`organizationSlug` (gửi lên → 400). Email unique **toàn cục** |
| `POST /auth/login` | Chỉ `email` + `password`, bỏ `orgSlug` |
| `/platform-admin/*` | **Xoá hẳn**. Thay bằng `POST /organizations`, `PATCH /organizations/:id/{status,slug}`, `POST|PATCH /categories` — cùng nhánh `/api/v1`, gác bằng `requireMaster` |
| Mọi route nghiệp vụ của org | Cần header `X-Org-Slug` (hoặc subdomain) trừ khi user chỉ thuộc một org |
| JWT | Payload chỉ còn `sub` — token cũ vô hiệu |
| Socket.IO handshake | Thêm `auth.organizationId` (bỏ qua được nếu chỉ thuộc một org); server đối chiếu membership |

## 3. Sáu phase

### Phase 1 — Nền quyền *(không phụ thuộc gì)*

- `role_grants` model + repository.
- **Tầng policy thuần** `src/common/authz/policy.ts`: hàm thuần trên tập grant, không chạm DB
  → test được không cần Mongo. Đây là chỗ duy nhất trả lời "được hay không".
- Ràng buộc §5.4: luôn còn ≥1 master · cấm tự nâng quyền · manager chỉ cấp staff trong scope mình.
- `audit_logs` mở rộng thành `moderation_events` (thêm `queue`, `fromStatus`, `toStatus`).

### Phase 2 — Org + slug *(không phụ thuộc Phase 1)*

- `organizations` v2: `orgType`, `capabilities`, `verificationTier`, `provinceCode`, `district`,
  `verifiedDomains[]`, `allowJoinRequests`, `allowOutsiderPosts` (default **false**), `slugNormalized`.
- `src/common/utils/slug.ts`: fold dấu tiếng Việt, chống ký tự nhìn giống Latin, reserved slugs.
- `org_units`, `org_slug_aliases`.
- API tra cứu slug (autocomplete, rate limit, không trả tên org ở nhánh kiểm tra khả dụng).

### Phase 3 — Auth + membership + join *(phụ thuộc 1, 2)* — **phase nặng nhất**

- `users`: bỏ `organizationId`, email unique toàn cục, thêm `emailVerifiedAt`.
- `memberships` + `join_requests` + màn duyệt hàng loạt kèm **gán nhóm con ngay trong thao tác duyệt** (§7.2a).
- Gộp `PlatformAdmin` → `User` + grant `master`.
- Viết lại `resolveTenant`: org hoạt động đến từ **membership + org được chọn tường minh**
  (header/route), không còn từ subdomain→user.
- `TenantScope` mới:
  ```ts
  { actorId, ownOrgId, readableOrgIds, publicAxis: null | { mode: 'approved' } | { mode: 'moderator', categoryIds, provinceCodes } }
  ```

### Phase 4 — Posts hai trục *(phụ thuộc 3)*

- `listings.organizationId` nullable + `visibility` + `provinceCode` (snapshot cứng) + `unitId`.
- `tenantPlugin` thêm option `dualAxis`: read filter thành
  `$or [ {organizationId ∈ readableOrgIds}, {organizationId: null, …publicAxis} ]`.
  Vế thứ hai lấy từ **scope**, không phải từ repository — giữ fail-closed ở tầng thấp nhất.
- Thuật toán định tuyến §11 + bảng ở §0.1 file này.
- Index viết lại: prefix `organizationId` không còn đúng cho trục công khai.

### Phase 5 — Quota + trust *(phụ thuộc 4)*

- 3 bucket (§8.2), trust level tách theo trục, reject counter **xuyên trục** 7 ngày (§8.4).
- Hiện trạng quota trong response để người dùng không đổ lỗi cho hệ thống.

### Phase 6 — Màn quản trị *(phụ thuộc 4, 5)*

- Hàng đợi org (2 tab: thành viên / người ngoài), hàng đợi danh mục.
- Dashboard phủ sóng cho master: ô (danh mục × tỉnh) nào chưa có manager, ô nào tồn đọng.
- Master reassign tin sang manager khác.

---

## 4. Migration

Một script `scripts/migrate-v2.ts`, idempotent, chạy sau khi deploy code:

1. `memberships` ← sinh từ `users.organizationId` hiện có (role: owner nếu `users._id == org.ownerId`, còn lại member; `joinedVia: 'roster'`).
2. `role_grants` ← `users.role = owner|moderator` → grant `staff` scope org; `platform_admins.super_admin` → grant `master`.
3. `listings.visibility` ← `org_internal` cho toàn bộ tin cũ (an toàn: không tự đẩy tin cũ ra công khai).
4. `listings.provinceCode` ← `location.province`.
5. Xoá `chainId` khỏi org, drop collection `chains`, drop index `users.organizationId_1_email_1`.
6. `syncIndexes()` cho mọi model.

**Không** xoá `users.organizationId` khỏi DB ở bước này — giữ một vòng deploy để rollback được,
xoá ở migration sau.

---

## 5. Test bắt buộc theo phase

| Phase | Test |
|---|---|
| 1 | policy thuần: master/manager/staff × 4 scope; cấm tự nâng quyền; chặn thu hồi master cuối |
| 2 | slug: fold dấu, reserved, trùng → gợi ý hậu tố; alias redirect |
| 3 | 1 user 2 org; join request duyệt/từ chối/hết hạn; cách ly org sau khi đổi org hoạt động |
| 4 | định tuyến 4 ca ở §0.1; tin trục công khai không lọt vào hàng đợi org và ngược lại |
| 5 | quota 3 bucket độc lập; reject counter khoá xuyên trục; uy tín không chuyển trục |
| 6 | manager danh mục không thấy tin ngoài tỉnh (điều kiện `WHERE`, không phải ẩn nút) |
