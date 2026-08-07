# Kiến trúc Multi-tenant: Chain / Organization / User

> Trạng thái: **ĐÃ IMPLEMENT**. Code là SoT — tài liệu này giữ lại phần *vì sao*.
> Hiện trạng + việc còn nợ → `multi-tenant.implementation.md`.
> Quy tắc bắt buộc khi viết code mới → `../rules/multi-tenant.convention.md`.
> Stack: **MongoDB 7 + Mongoose 8 + Express + TypeScript**.

## 0.0 Bản shipped khác thiết kế bên dưới ở đâu

Đọc bảng này trước, nó ghi đè phần tương ứng trong các mục sau.

| Mục | Thiết kế bên dưới | Bản đã ship | Vì sao đổi |
|---|---|---|---|
| §2, §3.1 | scope = `{ organizationIds[], writable }` | `{ ownOrgId, chainOrgIds[] }` + option `chainReadable` **theo schema** | Ghi luôn bị ép về `ownOrgId` nên cờ `writable` thành thừa; quyền đọc là thuộc tính của collection (chỉ `Listing`), không phải của route |
| §6.3 | `GET /chains/:id/listings` | **không tồn tại** | Tin cross-org trong chain đã tự có trong `GET /listings` cho mọi user (quyết định #15) — thêm route riêng là hai đường đọc cho cùng dữ liệu |
| §5.2 | text index `{ organizationId, title: 'text', ... }` | **không có text index**; `?q=` chạy regex | Scope đọc mặc định là `$in` nhiều org, vi phạm điều kiện prefix-equality của text index → vỡ ngay route tìm kiếm chính. Trần & đường nâng cấp ghi trong `listing.repository.buildFilter` |
| §4.3, §4.4 | `Listing` populate `seller` | snapshot `posterName` / `posterContact` | Populate cross-org lôi cả email/role của user org khác ra chỉ để hiện tên |
| §3.2 | `pre('save')` gán `organizationId` | `pre('validate')` | Mongoose chạy validation TRƯỚC pre-save của plugin → `organizationId is required` nổ trước khi hook kịp gán |
| §3.2 | `estimatedDocumentCount` "chặn ở review" | plugin ném lỗi | Rule nằm trong code rẻ hơn rule nằm trong đầu người review |

Điểm vào: `src/common/tenant/` · `src/middlewares/tenant.middleware.ts` ·
`src/features/{organization,chain,notification,platform-admin}/` ·
`scripts/migrate-tenant.ts` · `tests/unit/tenantPlugin.test.ts` ·
`tests/integration/tenant-isolation.test.ts`.

---

## 0. Sai lệch với tài liệu gốc — đã xử lý thế nào

| Tài liệu gốc | Thực tế repo | Cách xử lý |
|---|---|---|
| Postgres, Prisma | MongoDB, Mongoose | Schema viết lại theo Mongoose; "bảng" = collection, "FK" = `ObjectId` + `ref` (không có ràng buộc DB thật) |
| §4.4 bật Row-Level Security | Mongo không có RLS | Thay bằng **Tenant Context (AsyncLocalStorage) + Mongoose plugin fail-closed** — xem §3. Đây là lớp phòng thủ tương đương và mạnh hơn base-repository |
| "FK → User" | Mongo không enforce FK | Ràng buộc phải enforce ở service layer + index; liệt kê rõ ở §4 |
| `UNIQUE(organizationId, email)` | Hiện `email` đang `unique: true` toàn cục | Phải **drop index cũ** khi migrate, xem §8 |

---

## 1. Kiến trúc tổng thể

```
                    ┌─────────────────────────────────────┐
   HTTP request ───▶│ resolveTenant.middleware            │  org từ subdomain / JWT
                    │  → tenantContext.run({ orgIds })    │  ALS scope mở ở đây
                    └──────────────┬──────────────────────┘
                                   ▼
                    ┌─────────────────────────────────────┐
                    │ authenticate → authorize            │  user.organizationId ∈ scope?
                    └──────────────┬──────────────────────┘
                                   ▼
                    routes → controller → service → repository
                                                      │
                    ┌─────────────────────────────────▼───┐
                    │ Mongoose model + tenantPlugin       │  tự chèn organizationId
                    │  ↑ KHÔNG có scope = throw           │  vào MỌI query/ghi
                    └─────────────────────────────────────┘
```

**Ba tầng cô lập, độc lập nhau** (một tầng thủng vẫn còn hai tầng):

1. **Middleware** — dựng tenant scope từ nguồn đã verify (JWT / subdomain), không bao giờ từ body/query.
2. **Repository** — không tự viết filter `organizationId`; scope đến từ context.
3. **Mongoose plugin** — chèn filter ở tầng thấp nhất, **fail-closed**: không có scope thì ném lỗi chứ không query toàn bộ DB.

Tầng 3 là thứ thay thế RLS. Nếu ai đó viết một query mới và quên filter, plugin vẫn chèn — hoặc ném lỗi nếu chạy ngoài request context.

---

## 2. Tenant scope = một **tập** organizationId

Quyết định thiết kế quan trọng nhất của tài liệu này:

> Scope không phải `organizationId: string`, mà là `organizationIds: ObjectId[]`.

- Request thường của org → scope = `[orgId]` (tập 1 phần tử)
- Request chain read-only → scope = `[...orgIds thuộc chain]`

Nhờ vậy **không cần cờ bypass** (`crossTenant: true` kiểu như `withDeleted`). Chain
route không "thoát" khỏi plugin, nó chỉ chạy với scope rộng hơn. Không tồn tại đường
nào để query vượt ra ngoài scope — đó chính là điểm mà một cờ bypass sẽ phá vỡ.

Ghi (create/update/delete) thêm ràng buộc: **scope phải đúng 1 org**. Chain là read-only
(quyết định #5) nên plugin từ chối mọi thao tác ghi khi scope có > 1 org. Quy tắc nghiệp
vụ được enforce bằng code, không bằng review.

---

## 3. Cơ chế cô lập — thay thế RLS

### 3.1 Tenant context (`src/common/tenant/tenantContext.ts`)

```typescript
import { AsyncLocalStorage } from 'node:async_hooks'
import { Types } from 'mongoose'

export interface TenantScope {
  /** Danh sách org được phép chạm tới. 1 phần tử = request thường, nhiều = chain read-only. */
  organizationIds: Types.ObjectId[]
  /** false với chain scope — plugin sẽ chặn mọi thao tác ghi. */
  writable: boolean
}

const storage = new AsyncLocalStorage<TenantScope>()

export function runWithTenant<T>(scope: TenantScope, fn: () => T): T {
  return storage.run(scope, fn)
}

export function currentScope(): TenantScope | undefined {
  return storage.getStore()
}

/**
 * Dùng cho code chạy NGOÀI request: seed script, background job, migration.
 * Cố tình đặt tên xấu + phải gọi tường minh để `grep -rn "runUnscoped"` là ra hết
 * mọi chỗ có quyền đọc xuyên tenant.
 */
export function runUnscoped<T>(reason: string, fn: () => T): T {
  return storage.run({ organizationIds: [], writable: true, unscoped: true, reason } as never, fn)
}
```

### 3.2 Mongoose plugin (`src/common/tenant/tenantPlugin.ts`)

```typescript
// Hook phải liệt kê ĐẦY ĐỦ. /^find/ KHÔNG khớp updateMany/deleteMany/countDocuments/
// distinct — dùng regex ở đây là để lọt tenant, y hệt bug countDocuments của soft-delete.
const QUERY_HOOKS = [
  'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'countDocuments', 'distinct', 'replaceOne',
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
] as const

const WRITE_HOOKS = new Set(['findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'replaceOne', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'])

export function tenantPlugin(schema: Schema) {
  schema.add({
    organizationId: {
      type: Schema.Types.ObjectId, ref: 'Organization', required: true, immutable: true,
    },
  })

  for (const hook of QUERY_HOOKS) {
    schema.pre(hook, function () {
      const scope = requireScope(hook)                     // không có scope -> throw
      if (WRITE_HOOKS.has(hook)) assertWritable(scope)     // chain scope -> throw
      this.where({ organizationId: { $in: scope.organizationIds } })
    })
  }

  schema.pre('aggregate', function () {
    const scope = requireScope('aggregate')
    this.pipeline().unshift({ $match: { organizationId: { $in: scope.organizationIds } } })
  })

  schema.pre('save', function () {
    if (!this.isNew) return
    this.organizationId ??= requireWritableOrg()
  })

  schema.pre('insertMany', function (next, docs: Record<string, unknown>[]) {
    const orgId = requireWritableOrg()
    docs.forEach((d) => { d.organizationId ??= orgId })
    next()
  })
}
```

**`estimatedDocumentCount()` bị cấm** trên collection có tenant: nó đọc metadata cả
collection, không nhận filter, plugin không chặn được. Thêm rule lint hoặc chặn ở review.

### 3.3 Middleware (`src/middlewares/tenant.middleware.ts`)

```typescript
export const resolveTenant = catchAsync(async (req, _res, next) => {
  const orgId = req.user?.organizationId            // luôn từ JWT đã verify
  if (!orgId) throw new UnauthorizedError('Missing tenant context')

  const org = await organizationRepository.findActiveById(orgId)   // chạy runUnscoped
  if (!org) throw new ForbiddenError('Organization is suspended or removed')

  runWithTenant({ organizationIds: [org._id], writable: true }, next)
})
```

> `next()` phải được gọi **bên trong** `runWithTenant` để ALS context sống suốt phần
> còn lại của chain middleware. Gọi ngoài là context rỗng ngay lập tức — đây là lỗi
> hay gặp nhất khi dùng AsyncLocalStorage với Express.

---

## 4. Schema

### 4.1 `Chain`

| Field | Kiểu | Ghi chú |
|---|---|---|
| `_id` | ObjectId | |
| `name` | String, required, trim, maxlength 150 | |
| `slug` | String, required | unique — xem index §5 |
| `ownerId` | ObjectId → User, required | unique: 1 user chỉ chủ 1 chain |
| `status` | `'active' \| 'suspended'` | default `active` |
| `deletedAt` | Date \| null | soft delete, đồng bộ với model hiện có |
| `createdAt` / `updatedAt` | Date | `timestamps: true` |

Chain **không** có `tenantPlugin` — nó nằm trên tenant, không thuộc tenant nào.

### 4.2 `Organization`

| Field | Kiểu | Ghi chú |
|---|---|---|
| `_id` | ObjectId | |
| `chainId` | ObjectId → Chain, **nullable** | `null` = org độc lập (quyết định #6) |
| `name` | String, required | |
| `slug` | String, required | unique — dùng cho subdomain / login scope |
| `ownerId` | ObjectId → User, required | unique |
| `status` | `'active' \| 'suspended'` | |
| `deletedAt` | Date \| null | |

Cũng **không** có `tenantPlugin` (nó *là* tenant). Truy cập Organization đi qua
repository riêng chạy `runUnscoped`, và repository đó là nơi duy nhất được phép.

### 4.3 `User` — thay đổi so với hiện tại

```diff
+ organizationId: { type: ObjectId, ref: 'Organization', required: true, immutable: true }
- email: { ..., unique: true }          // ← PHẢI bỏ: unique toàn cục mâu thuẫn quyết định #2
+ email: { ..., trim: true, lowercase: true }
- role: enum(ROLES)                      // user | admin | moderator
+ role: enum(ORG_ROLES)                  // owner | moderator | member
```

`immutable: true` trên `organizationId`: một user **không bao giờ** chuyển org. Muốn
chuyển thì tạo tài khoản mới ở org mới — đúng với quyết định #2 (2 tài khoản riêng biệt).
Đây là ràng buộc rẻ nhất chặn nguyên một lớp lỗi.

User **không** dùng `tenantPlugin` vì luồng login phải tìm user *trước khi* có context.
Thay vào đó `userRepository` nhận `organizationId` tường minh ở mọi method — kiểu ép,
không phải kỷ luật. Xem §6.2.

### 4.4 Collection nghiệp vụ (`Listing`, `Notification`, `Report`, ...)

```typescript
listingSchema.plugin(tenantPlugin)   // tự thêm organizationId + mọi hook
```

Ràng buộc **không có DB nào enforce hộ**, phải làm ở service layer:

| Ràng buộc | Enforce ở đâu |
|---|---|
| `listing.seller.organizationId === listing.organizationId` | `listingService.create` — seller lấy từ `req.user`, cùng scope nên tự đúng |
| `listing.category` tồn tại | Category dùng chung (quyết định #7) — chỉ cần check tồn tại |
| `organizationId` không đổi sau khi tạo | `immutable: true` trong plugin |

### 4.5 `Category` — giữ nguyên, KHÔNG có tenant

Theo quyết định #7. Hệ quả cần biết trước: nếu sau này một org cần danh mục riêng,
migration sẽ phải backfill `organizationId` cho **toàn bộ** category và mọi listing
đang trỏ tới. Đảo quyết định này về sau đắt hơn nhiều so với làm ngay từ đầu — xem §9.

---

## 5. Index

### 5.1 Nguyên tắc số một

> **Mọi index trên collection có tenant đều phải lấy `organizationId` làm khoá đầu tiên.**

Vì mọi query đều bắt đầu bằng `organizationId: { $in: [...] }`, index không có prefix
này sẽ không được dùng hiệu quả — org lớn nhất sẽ làm chậm mọi org còn lại.

### 5.2 `Listing` — thay toàn bộ index hiện có

```typescript
// Query mặc định: list theo org, mới nhất trước
listingSchema.index({ organizationId: 1, status: 1, createdAt: -1 })
// Filter phổ biến
listingSchema.index({ organizationId: 1, category: 1, status: 1, createdAt: -1 })
listingSchema.index({ organizationId: 1, seller: 1, status: 1, createdAt: -1 })
listingSchema.index({ organizationId: 1, 'location.province': 1, status: 1, createdAt: -1 })
listingSchema.index({ organizationId: 1, price: 1, status: 1 })

// Geo: 2dsphere ĐƯỢC phép có prefix thường -> $near vẫn dùng index, đã lọc sẵn org
listingSchema.index({ organizationId: 1, location: '2dsphere' })

// Full-text: mỗi collection chỉ được MỘT text index -> đây là bản thay thế
listingSchema.index({ organizationId: 1, title: 'text', description: 'text' })

// Slug unique TRONG org, và chỉ tính bản ghi chưa xoá
listingSchema.index(
  { organizationId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)

// TTL: BẮT BUỘC single-field, không thể prefix organizationId
listingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

**Ba cạm bẫy phải nhớ:**

1. **Text index có prefix** → query `$text` **bắt buộc** kèm điều kiện bằng trên
   `organizationId`. Plugin luôn chèn `$in`. `$in` một phần tử được coi là equality nên
   chạy đúng; `$in` nhiều phần tử (chain scope) thì **không** thoả điều kiện prefix →
   `/chains/:id/listings` không dùng được `$text`. Xem §7.3 để biết cách xử lý.
2. **TTL không compound được.** Đừng cố prefix nó — Mongo sẽ từ chối tạo index. Nó là
   tiến trình dọn nền, không nằm trên đường query nên không ảnh hưởng hiệu năng tenant.
3. **Partial unique + soft delete**: không có `partialFilterExpression` thì một listing đã
   xoá vẫn giữ chỗ slug vĩnh viễn. Kiểm chứng lại filter này trên data thật một lần trước
   khi tin — hành vi so khớp `null` của partial index cần xác nhận với dataset cụ thể.

### 5.3 `User`

```typescript
userSchema.index(
  { organizationId: 1, email: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
)
userSchema.index({ organizationId: 1, role: 1 })
```

### 5.4 `Organization` / `Chain`

```typescript
organizationSchema.index({ slug: 1 }, { unique: true })
organizationSchema.index({ chainId: 1, status: 1 })     // resolve chain -> orgIds
organizationSchema.index({ ownerId: 1 }, { unique: true })

chainSchema.index({ slug: 1 }, { unique: true })
chainSchema.index({ ownerId: 1 }, { unique: true })
```

`{ chainId: 1, status: 1 }` là index đỡ toàn bộ nhóm route `/chains/*` — mọi request
chain đều bắt đầu bằng "org nào thuộc chain này".

---

## 6. Luồng nghiệp vụ

### 6.1 Đăng ký Organization mới — vòng lặp phụ thuộc

`Organization.ownerId` cần User, `User.organizationId` cần Organization. Trứng-và-gà.

**Không** giải bằng cách cho `ownerId` nullable rồi update sau (để lại cửa sổ tồn tại org
không chủ). Giải bằng cách sinh `_id` trước:

```typescript
const session = await mongoose.startSession()
await session.withTransaction(async () => {
  const orgId = new Types.ObjectId()      // sinh trước ở phía app
  const userId = new Types.ObjectId()

  await User.create([{ _id: userId, organizationId: orgId, role: ORG_ROLES.OWNER, ...input }], { session })
  await Organization.create([{ _id: orgId, ownerId: userId, chainId: null, ...input }], { session })
})
```

> Transaction đòi **replica set**. Atlas có sẵn; MongoDB standalone chạy local thì
> `withTransaction` sẽ lỗi. `docker-compose.yml` hiện dùng `mongo:7` standalone → phải
> chuyển sang single-node replica set (`--replSet rs0` + `rs.initiate()`) trước khi làm
> bước này.

### 6.2 Đăng nhập — **thiết kế hiện tại chưa chạy được**

Quyết định #2 cho phép cùng một email tồn tại ở nhiều org. Nhưng
`POST /auth/login { email, password }` khi đó **không xác định được** đăng nhập vào org nào.

Ba lựa chọn, khuyến nghị (a):

| | Cách | Đánh đổi |
|---|---|---|
| **(a)** | Subdomain quyết định org: `hungvuong.app.com` → resolve `Organization.slug` → tìm user trong org đó | Sạch nhất, khớp sẵn field `slug` đã có; buộc phải làm subdomain sớm hơn dự kiến |
| (b) | Body thêm `organizationSlug` | Không cần subdomain, nhưng UX phải bắt user nhớ/chọn tổ chức |
| (c) | Email unique toàn cục | Đơn giản nhất nhưng **mâu thuẫn quyết định #2** |

Chốt cái nào cũng được, nhưng **phải chốt trước khi code** — nó quyết định luôn câu hỏi
"subdomain làm ngay hay để sau" ở §7 tài liệu gốc.

Sau khi resolve được org, `authService.login` nhận thêm `organizationId` và
`userRepository.findByEmail(email, { organizationId })` — tham số bắt buộc, không optional.

### 6.3 Chain đọc tổng hợp

```typescript
// chain.middleware.ts
export const requireChainOwner = catchAsync(async (req, _res, next) => {
  const chain = await chainRepository.findActiveById(req.params.chainId)
  if (!chain || chain.ownerId.toString() !== req.user!.id) throw new ForbiddenError('Không phải chủ chain')

  const orgIds = await organizationRepository.activeIdsByChain(chain._id)
  runWithTenant({ organizationIds: orgIds, writable: false }, next)   // writable: false = chặn ghi
})
```

Từ đây trở đi `listingRepository.paginate()` **dùng lại nguyên xi** — không có nhánh
`if (isChainOwner)` nào trong service. Scope rộng hơn, code y hệt.

**Giới hạn đã biết:** `$in` nhiều org không thoả điều kiện prefix của text index, nên
`GET /chains/:id/listings` không hỗ trợ `?q=`. Hai cách xử lý — chọn khi implement:
bỏ ô search ở màn hình chain, hoặc fan-out từng org rồi merge (chậm hơn, phức tạp hơn).
Đừng để nó âm thầm chạy chậm rồi mới phát hiện.

---

## 7. Cấu trúc thư mục

Theo đúng `docs/rules/folder.convention.md` (7 layer mỗi feature, middleware riêng của
feature nằm trong feature đó):

```
src/
  common/
    tenant/                          ← MỚI (con của common/, không phải top-level mới)
      tenantContext.ts               AsyncLocalStorage + runWithTenant/runUnscoped
      tenantPlugin.ts                Mongoose plugin, fail-closed
      tenant.errors.ts               TenantScopeMissingError, CrossTenantWriteError
    constants/index.ts               + ORG_ROLES, ORG_STATUS, CHAIN_STATUS
  middlewares/
    tenant.middleware.ts             ← MỚI: resolveTenant (dùng chung mọi feature)
  features/
    organization/                    ← MỚI
      organization.{model,repository,service,controller,routes,schema,types}.ts
    chain/                           ← MỚI
      chain.{model,repository,service,controller,routes,schema,types}.ts
      chain.middleware.ts            requireChainOwner — chỉ chain dùng
    user/     listing/     auth/     ← sửa: thêm organizationId, đổi role, scope login
tests/
  unit/tenantPlugin.test.ts          ← BẮT BUỘC, xem §10
  integration/tenant-isolation.test.ts
```

`ORG_ROLES` thay `ROLES` hiện tại (`user|admin|moderator` → `owner|moderator|member`).
Giữ `ROLES` song song sẽ tạo hai từ vựng quyền cho cùng một thứ — xoá hẳn khi migrate.

---

## 8. Migration

Thứ tự bắt buộc, không đảo:

1. **Tạo org mặc định** cho toàn bộ data hiện có (`runUnscoped`).
2. **Backfill** `organizationId` cho `User`, `Listing`, và mọi collection nghiệp vụ.
3. **Drop index `email_1`** (unique toàn cục) — Mongoose *không* tự xoá index cũ, chỉ tạo mới.
   Bỏ qua bước này thì index cũ vẫn chặn trùng email xuyên org, mâu thuẫn quyết định #2:
   ```javascript
   db.users.dropIndex('email_1')
   db.listings.dropIndex('slug_1')
   ```
4. **Drop các index listing cũ** không có prefix `organizationId` (chúng chỉ tốn RAM/ghi).
5. Tạo index mới, `background: true` nếu chạy trên production có data.
6. Đặt `required: true` cho `organizationId` — chỉ sau khi backfill xong 100%.
7. Chuyển `docker-compose` mongo sang replica set (cần cho transaction ở §6.1).

Migration phải chạy được **lặp lại** (idempotent) — bước 2 dùng
`updateMany({ organizationId: { $exists: false } }, ...)`.

---

## 9. Các vấn đề chặn — đã chốt

1. **Login vào org nào?** Subdomain resolve `Organization.slug` trước khi authenticate
   (`APP_BASE_DOMAIN`); fallback dev/demo là `orgSlug` trong body login.
2. **Chain owner thuộc org nào?** Bất kỳ org nào — quyền chain đến từ `Chain.ownerId`,
   tách hẳn khỏi `role`. `User.organizationId` giữ nguyên required.
3. **Super-admin bên bán phần mềm** → collection `PlatformAdmin` riêng, JWT
   `type: 'platform_admin'`, nhánh `/platform-admin/*` không đi qua tenant plugin.
4. **`JWT_EXPIRES_IN`** → 15 phút. Suspend không đợi token: `resolveTenant` đọc
   `Organization.status` live (cache TTL 30s) mỗi request.
5. **Suspend có lan xuống không?** Chưa lan. Org bị suspend bị loại khỏi `chainOrgIds`;
   `Chain.status = suspended` mới chỉ chặn nhóm route `/chains/*`, chưa khoá org thành viên.
6. **Category dùng chung** — giữ nguyên quyết định #7, `Category` không có tenant.

### Còn treo (không chặn code hiện tại)

- Cơ chế mời user vào org sẵn có (giờ chỉ tạo được owner qua `POST /auth/register`).
- Refresh token rotate/revoke — hiện chỉ ký lại, chưa có store.
- Chuyển `?q=` sang Atlas Search (cần cluster Atlas, không chạy được với
  `mongodb-memory-server`).
- Cache `chainOrgIds` + status đang in-memory; cần Redis khi chạy nhiều instance.
- Billing gắn ở cấp Organization hay Chain.
- Nhắn tin xuyên org trong cùng chain, hay chỉ hiện `posterContact` tĩnh.

---

## 10. Test bắt buộc trước khi coi là xong

Cô lập tenant là ranh giới bảo mật — không nhận "code review thấy ổn" làm bằng chứng.
Tối thiểu:

```
tests/unit/tenantPlugin.test.ts
  ✓ find/count/update/delete/aggregate đều bị chèn organizationId
  ✓ không có scope -> throw, KHÔNG trả về toàn bộ document
  ✓ scope nhiều org (chain) -> mọi thao tác ghi bị từ chối
  ✓ organizationId từ client bị bỏ qua, luôn lấy từ context

tests/integration/tenant-isolation.test.ts
  ✓ user org A không đọc/sửa/xoá được listing org B (404, không phải 403 — không lộ tồn tại)
  ✓ trùng email ở 2 org tạo được 2 tài khoản riêng
  ✓ chain owner đọc được listing của mọi org thành viên
  ✓ chain owner KHÔNG ghi được vào bất kỳ org nào
```

Bài test cuối cùng là bài quan trọng nhất: nó là thứ duy nhất chứng minh quyết định #5
(chain read-only) thực sự được enforce chứ không chỉ nằm trên giấy.
