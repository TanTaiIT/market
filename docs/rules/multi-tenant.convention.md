# Multi-tenant Rules

> ⚠️ **v2 ĐÃ THAY ĐỔI BỐN ĐIỀU DƯỚI ĐÂY — đọc mục này trước, nó ghi đè mọi chỗ mâu thuẫn
> trong phần còn lại của file.** Trạng thái đích: `docs/architecture/v2-org-permission.plan.md`.
>
> | Tài liệu này nói | v2 thực tế |
> |---|---|
> | `chainReadable`, đọc xuyên org trong chain | **Chain đã bị gỡ.** Thay bằng option `dualAxis` — trục org (`organizationId`) và trục danh mục (`visibility: public`) |
> | `ORG_ROLES` (owner/moderator/member) trên `users` | **Tách đôi**: `memberships.role` = thân phận, `role_grants` = quyền hạn. `users` không còn `organizationId` lẫn `role` |
> | Nhánh `/platform-admin/*` + JWT `type` | **Đã xoá.** `master` là một `role_grant` scope `system` trên User thường; JWT chỉ còn `sub` |
> | Org lấy từ subdomain → `orgSlug` body → JWT | subdomain → header `X-Org-Slug` → (nếu chỉ thuộc 1 org) org đó, rồi **đối chiếu `memberships` ngay lúc đó** |
>
> Ba điều KHÔNG đổi và vẫn là luật: filter tenant nằm ở `tenantPlugin` chứ không ở repository ·
> không có scope thì ném lỗi, không bao giờ query toàn DB · `runUnscoped('lý do', …)` là lối
> thoát DUY NHẤT và phải grep ra được.

Tài liệu này quy định các nguyên tắc **bắt buộc** khi viết code chạm tới dữ liệu khách
hàng. Cách ly tenant là ranh giới bảo mật: một query quên filter không phải là bug hiệu
năng, nó là rò rỉ dữ liệu giữa hai khách hàng khác nhau.

- Thiết kế + lý do (bản v1) → `docs/architecture/multi-tenant.md`
- Trạng thái đích của v2 → `docs/architecture/v2-org-permission.plan.md`
- Tài liệu này chỉ trả lời: **lần sau viết code thì phải làm gì.**

---

## 0. Sáu bất biến — vi phạm là reject ngay

1. **Mọi collection nghiệp vụ đều gắn `tenantPlugin`.** Không có collection nào "tạm thời
   chưa cần tenant". Ngoại lệ duy nhất đã được duyệt: `User`, `Membership`, `RoleGrant`,
   `JoinRequest`, `Trust`, `Organization`, `Category`, `FieldDefinition`, `CategoryTemplate`
   — xem §1.3 để biết vì sao và bù bằng gì.
2. **Không tự viết filter `organizationId` trong repository/service.** Scope đến từ
   context. Tự viết nghĩa là đang có hai nguồn sự thật, và cái viết tay sẽ sai trước.
3. **Ghi luôn rơi về `ownOrgId`.** Không route nào, không role nào, không cờ nào mở rộng
   được phạm vi ghi. Bản ghi của trục công khai (`organizationId: null`) là read-only với
   mọi org khác — quyền ở đó đến từ `role_grants`, không từ tenant scope.
4. **Không có scope thì ném lỗi, không bao giờ query không filter.** Fail-closed là mặc
   định; nếu thấy mình muốn thêm fallback "cho tiện", dừng lại.
5. **`organizationId` do client gửi lên luôn bị bỏ qua.** Nó chỉ đến từ token đã verify
   hoặc từ subdomain, không bao giờ từ body/query/params.
6. **Mọi index trên collection có tenant lấy `organizationId` làm khoá đầu tiên.** Ngoại
   lệ duy nhất là TTL index (Mongo không cho compound).

---

## 1. Thêm collection nghiệp vụ mới

### 1.1 Gắn plugin trước, khai index sau

```ts
// PHẢI đứng trước phần index: plugin mới là chỗ thêm field organizationId vào schema.
reportSchema.plugin(tenantPlugin)

reportSchema.index({ organizationId: 1, createdAt: -1 })
```

Đảo thứ tự thì `organizationId` chưa tồn tại lúc khai index → index sai âm thầm.

### 1.2 Quyết định `dualAxis`

`dualAxis` khai báo **theo schema**, không theo route. Câu hỏi cần trả lời:

> *Bản ghi này có sống được ngoài mọi tổ chức không?*

| Trả lời | Khai báo | Hiện có |
|---|---|---|
| Có | `plugin(tenantPlugin, { dualAxis: true })` | `Listing` |
| Không | `plugin(tenantPlugin)` | `Notification`, `OrgUnit`, và mặc định cho mọi collection mới |

**Mặc định là tắt.** Bật lên đổi hai thứ cùng lúc, nên phải nêu được lý do nghiệp vụ trong PR:

- `organizationId` chuyển thành nullable (`null` = bản ghi của trục công khai, không thuộc org nào)
- khoá định tuyến không còn là `organizationId` mà là **`visibility`** — `public` đi về người
  phụ trách (danh mục × tỉnh), `org_internal` đi về chính tổ chức

Đây là chỗ hay nhầm nhất: `organizationId` vẫn được ghi trên tin công khai của một thành viên,
nhưng nó chỉ để **hiển thị nguồn gốc**, không quyết định ai duyệt. Xem
`listing.routing.ts` và test `two-axis.test.ts` — cả hai tồn tại để chốt đúng điều này.

Đừng bật `dualAxis` chỉ vì "cần đọc rộng hơn một chút". Đọc rộng có chủ đích thì bọc
`runUnscoped('lý do', ...)` ở đúng chỗ đó (§1.4) — nó để lại vết grep được, còn `dualAxis`
thì nới scope cho **mọi** truy vấn của collection.

### 1.3 Collection KHÔNG gắn plugin — và phải bù bằng gì

| Collection | Vì sao không gắn | Bù bằng |
|---|---|---|
| `User` | Tài khoản là **toàn cục** ở v2 — không thuộc org nào | Quan hệ với org nằm ở `Membership`; `User` không có cột `organizationId` lẫn `role` |
| `Membership` | Chính nó trả lời "request đang ở org nào" → phải đọc được TRƯỚC khi scope tồn tại | Mọi method của repository nhận `organizationId` tường minh, ép bằng kiểu |
| `RoleGrant` | Nguồn của phân quyền, cũng phải đọc trước scope | Đọc qua `roleGrantService.grantsOf(userId)`, quyết định ở `authz/policy.ts` |
| `JoinRequest` | Người gửi theo định nghĩa **chưa** thuộc org đích | Org đích đi trong body (`orgSlug`); hàng đợi lọc bằng `organizationId` tường minh |
| `Trust` | Uy tín thuộc trục danh mục, không thuộc tổ chức nào | — |
| `Organization` | Chính nó *là* tenant | Chỉ truy cập qua repository của feature đó |
| `Category` | Dùng chung toàn hệ thống (quyết định #7) | Không có dữ liệu riêng của khách hàng |
| `FieldDefinition` | Từ điển field của template tin đăng — cùng lý do với `Category` | Không có dữ liệu riêng của khách hàng; ghi chỉ qua `scripts/seed-templates.ts` |
| `CategoryTemplate` | Template gắn với `Category`, mà `Category` đã ngoài tenant | Như trên; API chỉ mở đường ĐỌC (`GET /categories/{id}/template`) |

Muốn thêm một collection vào danh sách này → **dừng lại và hỏi**, không tự quyết.

---

## 2. Repository & Service

### 2.1 Repository không biết gì về org

```ts
// ĐÚNG — plugin lo phần tenant, repository chỉ lo nghiệp vụ
findActive() {
  return Report.find({ status: 'open' })
}

// SAI — hai nguồn sự thật, và cái viết tay sẽ lệch trước
findActive(orgId: string) {
  return Report.find({ status: 'open', organizationId: orgId })
}
```

Ngoại lệ duy nhất: repository của collection ở §1.3, nơi `organizationId` là tham số bắt
buộc.

### 2.2 Lấy scope ở đâu

| Cần gì | Dùng | Lỗi khi không có scope |
|---|---|---|
| Bắt buộc phải có scope | `requireScope('tên thao tác')` | Ném `TenantScopeMissingError` (400) |
| Có thì dùng, không có cũng được | `currentScope()` | Trả `undefined` |

Service của collection **không** gắn plugin (§1.3) phải tự `requireScope()` — xem
`user.service.ts` làm mẫu. Đừng nhận `organizationId` từ controller: controller lấy ở đâu
ra thì lại là một câu hỏi nữa.

### 2.3 KHÔNG populate xuyên tenant

```ts
// SAI — User không có plugin, populate lôi cả email/role của user org khác ra
Listing.find().populate('seller')
```

Cần hiển thị dữ liệu của entity thuộc org khác → **denormalize snapshot** vào chính bản
ghi lúc tạo (`Listing.posterName` / `posterContact` là mẫu), đừng mở đường đọc.

Nhớ luôn: `populate` vào model **chưa tồn tại** ném `MissingSchemaError` lúc runtime, TS
không bắt được. Chỉ populate model đã thực sự `mongoose.model(...)`.

---

## 3. Index

```ts
schema.index({ organizationId: 1, status: 1, createdAt: -1 })   // filter + sort thường dùng
schema.index({ organizationId: 1, location: '2dsphere' })        // geo: compound được
schema.index(                                                    // unique TRONG org
  { organizationId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })        // TTL: BẮT BUỘC single-field
```

| Loại | Prefix `organizationId`? | Ghi chú |
|---|---|---|
| Index thường | ✅ bắt buộc | Thiếu prefix thì org lớn nhất làm chậm mọi org còn lại |
| `2dsphere` | ✅ được | `$near` vẫn dùng được index |
| TTL | ❌ không thể | Mongo từ chối compound TTL. Nó là tiến trình dọn nền, không nằm trên đường query |
| **Text index** | ❌ **cấm dùng** | Text index có prefix bắt buộc equality trên prefix, mà scope đọc mặc định là `$in` nhiều org → vỡ. Full-text đi đường Atlas Search |

**Unique + soft delete**: luôn kèm `partialFilterExpression: { deletedAt: null }`, nếu
không một bản ghi đã xoá sẽ giữ chỗ giá trị unique vĩnh viễn.

---

## 4. Route & Middleware

### 4.1 Thứ tự middleware — không đảo

```
resolveTenant  →  authenticate  →  (requireOrg* / require*Moderator)  →  validate  →  controller
```

- `resolveTenant` mount ở `app.ts` cho cả `API_PREFIX`, không mount lại ở feature.
- Token KHÔNG mang org nữa (payload chỉ có `sub`). Câu hỏi "người này có thuộc org đang
  resolve không" do chính `resolveTenant` đối chiếu với `memberships` tại thời điểm đó, nên
  không còn bước so token với scope — và cũng không còn cách nào cầm token cũ đi vào org khác.

### 4.2 Middleware riêng của feature nằm trong feature

`requireCategoryModerator` / `requireMasterPublicAxis` ở
`src/features/moderation/moderation.middleware.ts`, không ở `src/middlewares/` (quy tắc 6 của
`folder.convention.md`). Chỉ middleware dùng chung nhiều feature — `requireOrg`,
`requireMembership`, `requireOrgModerator`, `requireOrgAdmin` — mới lên `src/middlewares/`.

### 4.3 `next()` phải gọi BÊN TRONG `runWithTenant`

```ts
// ĐÚNG
runWithTenant(scope, next)

// SAI — context rỗng ngay lập tức
runWithTenant(scope, () => {})
next()
```

Đây là lỗi hay gặp nhất khi dùng AsyncLocalStorage với Express.

### 4.4 Không đẻ route "xem xuyên org"

Dữ liệu `dualAxis` đã tự có mặt trong route đọc thông thường. Thêm một route "xem tất cả"
song song là tạo hai đường đọc cho cùng một dữ liệu, và hai đường đọc thì sớm muộn sẽ phân
quyền lệch nhau.

Ngoại lệ đã duyệt: một tham số **đổi câu hỏi**, không phải nới phạm vi —
`GET /notifications?scope=managed` hỏi "tôi gửi được tới đâu" thay cho "tôi nhận được gì".
Hai câu hỏi khác nhau, cùng đi qua một `policy.ts`, nên không đẻ ra đường phân quyền thứ hai.

---

## 5. Auth & Token

1. JWT payload bắt buộc có `type` (`'user'` | `'platform_admin'`). Middleware phải check
   `type` trước khi tin bất cứ field nào khác — hai hệ thống ký cùng secret.
2. Token user bắt buộc mang `organizationId`.
3. Bất kỳ luồng nào tìm `User` theo email đều phải kèm `organizationId` — `email` chỉ
   unique trong phạm vi `(organizationId, email)`.
4. **Không** rút thông tin tenant từ body/query để phân quyền. `orgSlug` trong body login
   là ngoại lệ đã duyệt, và nó chỉ dùng để *resolve org*, không dùng để cấp quyền.
5. Đổi `JWT_EXPIRES_IN` dài ra phải đi kèm lý do: suspend org dựa vào token ngắn + check
   status live, nới token là nới cả hai.

---

## 6. Chạy code ngoài request

Seed, migration, cron job, fan-out — những chỗ không có request nên không có scope.

```ts
await runUnscoped('lý do cụ thể', async () => {
  await Report.insertMany(rows)   // mỗi document PHẢI tự mang organizationId
})
```

Quy tắc:

1. `reason` viết cụ thể, không viết `'script'`. `grep -rn "runUnscoped"` là danh sách
   kiểm toán mọi lối đi xuyên tenant — nó chỉ có giá trị khi lý do đọc được.
2. Trong `runUnscoped`, plugin **không** gán `organizationId` hộ. Document thiếu field này
   sẽ bị từ chối bằng `CrossTenantWriteError`.
3. **Query của Mongoose là lazy.** `.exec()` (hoặc `await`) phải nằm TRONG callback:

```ts
// SAI — Query chạy sau khi AsyncLocalStorage đã đóng scope
const rows = await runUnscoped('audit', () => Report.find())

// ĐÚNG
const rows = await runUnscoped('audit', () => Report.find().exec())
```

4. Thêm một call site `runUnscoped` mới là thay đổi đáng review kỹ. Nếu nó nằm trong
   luồng request, gần như chắc chắn đang làm sai — hỏi trước.

---

## 7. Cấm tuyệt đối

| Anti-pattern | Vì sao | Thay bằng |
|---|---|---|
| Thêm cờ bypass kiểu `crossTenant: true` | Có một đường thoát là có mọi đường thoát | `runUnscoped('lý do', ...)` tại đúng chỗ cần — nó grep được |
| `estimatedDocumentCount()` | Đọc metadata cả collection, không nhận filter | `countDocuments()` — plugin đã chặn cứng, đừng tìm cách lách |
| `pre('save')` để gán `organizationId` | Mongoose chạy validation TRƯỚC pre-save của plugin | `pre('validate')` (plugin đã làm sẵn, đừng tự viết) |
| `organizationId` mutable | Cho phép chuyển bản ghi sang org khác | `immutable: true` (plugin đã set) |
| `populate` sang collection không có plugin | Lách được cách ly | Snapshot field |
| Filter `organizationId` viết tay trong service | Hai nguồn sự thật | Để plugin làm |
| Bỏ qua `partialFilterExpression` ở unique index | Bản ghi đã xoá giữ chỗ vĩnh viễn | Luôn kèm `{ deletedAt: null }` |
| Text index trên collection có tenant | Vỡ với scope `$in` nhiều org | Atlas Search |

---

## 8. Test bắt buộc trước khi merge

Thêm collection có tenant, hoặc đổi bất cứ thứ gì trong `src/common/tenant/`, thì **không
nhận "code review thấy ổn" làm bằng chứng**. Tối thiểu phải có:

- [ ] Org A không đọc được bản ghi của org B → **404**, không phải 403 (403 là lộ sự tồn tại)
- [ ] Org A không sửa/xoá được bản ghi của org B
- [ ] Không có scope → throw, KHÔNG trả về toàn bộ document
- [ ] `organizationId` client gửi lên bị bỏ qua (cả `create` lẫn `insertMany`)
- [ ] Nếu bật `dualAxis`: bản ghi `organizationId: null` đọc được từ mọi org, nhưng ghi thì **không**

Mẫu bám theo: `tests/unit/tenantPlugin.test.ts` (tầng plugin) và
`tests/integration/tenant-isolation.test.ts` (tầng HTTP).

Integration test đụng luồng đăng ký Organization phải dùng `MongoMemoryReplSet` —
transaction không chạy trên standalone.

---

## 9. Checklist trước khi mở PR

- [ ] Collection mới đã `plugin(tenantPlugin)`, và `dualAxis` để mặc định tắt trừ khi PR
      nêu rõ lý do nghiệp vụ
- [ ] Mọi index mới có `organizationId` đứng đầu (trừ TTL)
- [ ] Unique index kèm `partialFilterExpression: { deletedAt: null }`
- [ ] Repository không có chuỗi `organizationId` viết tay
- [ ] Không có `populate` sang collection thiếu plugin
- [ ] `runUnscoped` mới (nếu có) đã được nêu trong PR description kèm lý do
- [ ] Có test cách ly theo §8
- [ ] `npm run lint` · `npm run typecheck` · `npm test` đều pass
- [ ] Đổi schema → ghi rõ trong PR có cần chạy `npm run migrate:tenant` không

---

### Ghi chú tuân thủ

Các quy tắc trên là bắt buộc (mandatory), không phải khuyến nghị. Riêng nhóm §0 và §7,
vi phạm được coi là lỗi bảo mật chứ không phải lỗi style — chặn tại code review, không
merge rồi sửa sau.
