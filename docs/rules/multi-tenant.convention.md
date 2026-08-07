# Multi-tenant Rules

Tài liệu này quy định các nguyên tắc **bắt buộc** khi viết code chạm tới dữ liệu khách
hàng. Cách ly tenant là ranh giới bảo mật: một query quên filter không phải là bug hiệu
năng, nó là rò rỉ dữ liệu giữa hai khách hàng khác nhau.

- Thiết kế + lý do → `docs/architecture/multi-tenant.md`
- Hiện trạng + việc còn nợ → `docs/architecture/multi-tenant.implementation.md`
- Tài liệu này chỉ trả lời: **lần sau viết code thì phải làm gì.**

---

## 0. Sáu bất biến — vi phạm là reject ngay

1. **Mọi collection nghiệp vụ đều gắn `tenantPlugin`.** Không có collection nào "tạm thời
   chưa cần tenant". Ngoại lệ duy nhất đã được duyệt: `User`, `Organization`, `Chain`,
   `PlatformAdmin`, `Category` — xem §1.3 để biết vì sao và phải bù bằng gì.
2. **Không tự viết filter `organizationId` trong repository/service.** Scope đến từ
   context. Tự viết nghĩa là đang có hai nguồn sự thật, và cái viết tay sẽ sai trước.
3. **Ghi luôn rơi về `ownOrgId`.** Không route nào, không role nào, không cờ nào mở rộng
   được phạm vi ghi. Chain là read-only.
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

### 1.2 Quyết định `chainReadable`

`chainReadable` khai báo **theo schema**, không theo route. Câu hỏi cần trả lời:

> *User của org A có được phép nhìn thấy bản ghi này của org B khi hai org cùng chain
> không?*

| Trả lời | Khai báo | Hiện có |
|---|---|---|
| Có | `plugin(tenantPlugin, { chainReadable: true })` | `Listing` |
| Không | `plugin(tenantPlugin)` | `Notification`, và mặc định cho mọi collection mới |

**Mặc định là `false`.** Bật `true` phải nêu được lý do nghiệp vụ trong PR description.
Nếu chỉ vì "chain owner cần xem thống kê" thì **không** bật — dùng route chain riêng với
`requireChainOwner`, nó mở scope rộng hơn mà không đổi quyền của user thường.

### 1.3 Collection KHÔNG gắn plugin — và phải bù bằng gì

| Collection | Vì sao không gắn | Bù bằng |
|---|---|---|
| `User` | Login phải tìm user TRƯỚC khi có context | `userRepository` nhận `organizationId` **bắt buộc, không optional** ở mọi method |
| `Organization`, `Chain` | Chúng *là* / *ở trên* tenant | Chỉ truy cập qua repository của chính feature đó |
| `PlatformAdmin` | Ngoài mô hình tenant hoàn toàn | Nhánh `/platform-admin/*`, JWT `type` riêng |
| `Category` | Dùng chung toàn hệ thống (quyết định #7) | Không có dữ liệu riêng của khách hàng |

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
resolveTenant  →  authenticate  →  (requireChainOwner)  →  validate  →  controller
```

- `resolveTenant` mount ở `app.ts` cho cả `API_PREFIX`, không mount lại ở feature.
- `authenticate` kiểm tra `payload.organizationId === scope.ownOrgId`. Thiếu bước này thì
  user org A cầm token của mình gọi vào subdomain org B sẽ chạy với scope của B.

### 4.2 Middleware riêng của feature nằm trong feature

`requireChainOwner` ở `src/features/chain/chain.middleware.ts`, không ở `src/middlewares/`
(quy tắc 6 của `folder.convention.md`). Chỉ middleware dùng chung nhiều feature mới lên
`src/middlewares/`.

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

Dữ liệu `chainReadable` đã tự có mặt trong route đọc thông thường. Thêm
`GET /chains/:id/<resource>` song song là tạo hai đường đọc cho cùng một dữ liệu, và hai
đường đọc thì sớm muộn sẽ phân quyền lệch nhau. Route `/chains/*` chỉ dành cho **thống kê
tổng hợp** và **thao tác cấp chain** (vd fan-out thông báo).

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
| Thêm cờ bypass kiểu `crossTenant: true` | Có một đường thoát là có mọi đường thoát | Mở scope rộng hơn bằng middleware (`requireChainOwner`) |
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
- [ ] Nếu bật `chainReadable`: đọc được xuyên chain, nhưng ghi thì **không**

Mẫu bám theo: `tests/unit/tenantPlugin.test.ts` (tầng plugin) và
`tests/integration/tenant-isolation.test.ts` (tầng HTTP).

Integration test đụng luồng đăng ký Organization phải dùng `MongoMemoryReplSet` —
transaction không chạy trên standalone.

---

## 9. Checklist trước khi mở PR

- [ ] Collection mới đã `plugin(tenantPlugin)`, và `chainReadable` để mặc định `false`
      trừ khi PR nêu rõ lý do nghiệp vụ
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
