# Template tin đăng theo danh mục — kế hoạch thi công

> Nguồn nghiệp vụ: bản đặc tả "Hệ Template tin đăng" (Phần I–VI). File này là **kế hoạch thi
> công trên code hiện có** của hai repo, không lặp lại phần nghiệp vụ.
>
> | Repo | Thư mục | Remote | Vai trò |
> |---|---|---|---|
> | BE | `docs/Vue` | `market.git` | Express + Mongoose + Zod. SoT: `AGENT.md` |
> | FE | `docs/VueRoute` | `market-place.git` | Expo RN + TanStack Query. SoT: `AGENTS.md` |
>
> Hai repo là git repo lồng, tách biệt — mỗi phase commit riêng bên nó.

---

## 0. Bảy quyết định phải chốt trước khi gõ dòng code đầu tiên

Đặc tả viết ở mức trung lập; code hiện có đã chốt sẵn vài thứ ngược lại. Bảng dưới là chỗ
chúng va nhau.

| # | Câu hỏi | Đề xuất chốt | Hệ quả lớn nhất |
|---|---|---|---|
| D1 | `attributes` lưu kiểu gì | **`Map` of `Mixed`** | Breaking type ở response — xem §0.1 |
| D2 | Validate template chạy ở tầng nào | **Service, không phải zod middleware** | §0.2 |
| D3 | Index cho `attrs` | **2 index, prefix theo trục** — không phải 1 như đặc tả | §0.3 |
| D4 | Có màn quản trị sửa template không | **Không ở v1** — seed script + endpoint đọc | §0.4 |
| D5 | Danh mục Thú cưng | **Hạ tầng làm, danh mục để `isActive:false`** | §0.5 |
| D6 | `priceUnit` của BĐS | **Chỉ hiển thị ở v1**, không nhập vào bộ lọc giá | §0.6 |
| D7 | Đường `api:sync` của FE | **Đổi tên `docs/Vue` → `docs/market`** | §0.7 — đang hỏng |

### 0.1 `attributes` đang là `Map<string, String>`

`listing.model.ts:147` khai `{ type: Map, of: String }`, `listing.schema.ts:60` khai
`z.record(z.string())`. Đặc tả cần `Number`, `Boolean`, `Array<String>`.

Giữ nguyên String thì mất đúng thứ đặc tả §5.4 đã cảnh báo: `storage: "256"` không match
`$gte: 128`, và `filterable` trên `number` trở thành vô nghĩa.

`api-contract.md §2` cấm đổi kiểu field response đã public. Nhưng ở đây **chưa có consumer
thật**: FE `toListing()` (`client.ts:124`) không đọc `attributes`, và chỗ duy nhất ghi nó là
`scripts/seed-bulk.ts`. Nên đổi sang `Mixed` bây giờ là rẻ nhất nó từng có — hoãn lại thì
mỗi tháng thêm một tệp dữ liệu phải migrate.

→ `Map of Schema.Types.Mixed` + migration ép kiểu dữ liệu cũ (§3.6).

### 0.2 Zod không validate được template

`validate({ body })` là middleware **tĩnh** — nó không đọc DB. Mà template thì tra theo
`categoryId` nằm trong chính body đó. Hai đường:

- zod giữ vai trò cũ: chặn hình dạng (`z.record(z.unknown())`, giới hạn số key, độ sâu 1);
- `listingService.create/update` gọi `templateService.validateAttributes(categoryId, raw)`,
  ném `BadRequestError` — đúng AGENT rule 3, và đúng chỗ `categoryService.assertUsable()`
  đang đứng (`listing.service.ts:293`).

Không nới `validate()` thành async-DB-aware: nó là middleware dùng chung của mọi feature.

### 0.3 Index `attrs` phải theo hai trục, không phải một

Đặc tả §5.3 đề xuất `{ 'attrs.k': 1, 'attrs.v': 1 }`. `Listing` có `tenantPlugin(dualAxis)`,
mà **AGENT rule 13**: mọi index trên collection có tenant phải lấy `organizationId` làm khoá
đầu. Và `listing.model.ts` đã có sẵn *hai họ* index vì hai trục truy vấn không dùng chung
index được. `attrs` phải theo đúng khuôn đó:

```
{ organizationId: 1, 'attrs.k': 1, 'attrs.v': 1 }          // trục org
{ visibility: 1, status: 1, 'attrs.k': 1, 'attrs.v': 1 }   // trục danh mục
```

Hai index này là chi phí thật trên M0 512 MB → kỷ luật `attrs` **chỉ chứa field
`filterable: true`** (đặc tả §5.3) là ràng buộc bắt buộc, không phải lời khuyên.

> **Đã thi công:** field `attrs` có rồi, **index thì chưa** — chúng thuộc BE-5 và land cùng
> `?attrs=`. Index không có query đọc chỉ tốn chi phí ghi, và tách đôi thì không ai đối chiếu
> được hình dạng `$elemMatch` thật với hình dạng index.

### 0.4 Không dựng màn sửa template ở v1

Đặc tả §5.1 đã tự trả lời: seed script idempotent. Template đổi vài tháng một lần, chỉ master
sửa, và mỗi lần sửa là **tạo version mới** chứ không phải sửa tại chỗ (§Bước 6) — một form CRUD
trong RN không diễn đạt được cái đó mà không dựng thêm cả trình quản lý version.

v1: BE có `GET /categories/{id}/template` (đọc) + `scripts/seed-templates.ts` (ghi). Màn
`app/admin/categories.tsx` chỉ thêm một dòng "đã có template / dùng bản chung".

Ghi lại là nợ có chủ ý, không phải quên.

### 0.5 Thú cưng — hạ tầng làm, cửa để đóng

Đặc tả §4.6 tự nêu ba việc bắt buộc và tự nói không nắm chắc chính sách store. Cách rẻ nhất
để không phải đoán: làm đủ template + cơ chế chặn auto-approve, rồi seed danh mục với
`isActive: false`. Mở cửa là một lần `PATCH /categories/{id}` sau khi đã đọc policy.

Cơ chế chặn: thêm `Category.requireManualReview: boolean`. `listing.service` đọc nó và ép
`autoApprove: false` trước khi gọi `routeListing()` — `listing.routing.ts` là hàm thuần, giữ
nguyên nó, chỉ đổi input.

### 0.6 `priceUnit` của BĐS

`price` của tin thuê mang nghĩa "mỗi tháng". Trộn nó vào `minPrice/maxPrice` chung với giá bán
là bộ lọc trả kết quả sai một cách im lặng. BĐS lại đứng cuối thứ tự triển khai → v1 chỉ thêm
`priceUnit: 'total' | 'month'` để **hiển thị** ("2.5tr/tháng"), chưa đụng `buildFilter`.

### 0.7 `npm run api:sync` của FE đang hỏng

`docs/VueRoute/openapi-ts.config.ts` trỏ `input: '../market/openapi.json'`, tức
`docs/market/openapi.json` — **thư mục đó không tồn tại**, spec thật nằm ở `docs/Vue/openapi.json`.
SDK trong `src/api/generated/**` vì thế đang đứng lại ở bản sinh từ lâu và mọi lần sync đều hỏng
im lặng.

Đổi tên `docs/Vue` → `docs/market`: git remote là `market.git`, config trỏ `market`, plan
`v2-org-permission.plan.md` cũng viết `docs/market`. Chỉ có thư mục checkout là lệch.

**Đây là việc phải làm TRƯỚC Phase FE-1**, nếu không SDK sẽ không có type của endpoint template.

---

## 1. Hiện trạng vs đặc tả

| Đặc tả cần | Code hiện có | Khoảng cách |
|---|---|---|
| `field_definitions` | — | Collection mới |
| `category_templates` (versioned) | — | Collection mới |
| `Listing.templateRef` | — | Field mới |
| `Listing.attrs[]` | — | Field mới, sinh lúc ghi |
| `Listing.attributes` đa kiểu | `Map of String` | Đổi kiểu + migration |
| Template fallback | — | Bản ghi `isFallback: true` |
| 6 danh mục | 4 danh mục khác hẳn (`sach-vo`, `xe-dap`, `dien-tu`, `do-dung`) | Seed lại, không migrate |
| Renderer form động | `ListingForm.tsx` 8 field cứng | Component mới |
| Lọc theo `attrs` | `buildFilter` chỉ có category/price/province/q | Mở rộng |
| Chặn auto-approve theo danh mục | `isAutoApprove(trust, rejections)` | `Category.requireManualReview` |

Bốn danh mục đang seed **không** ánh xạ được sang 6 danh mục đặc tả (`dien-tu` ≠ `do-dien-tu`,
`xe-dap` là một `vehicleType` bên trong `xe-co`). Đây là seed dev, `scripts/seed.ts:177` đã
`deleteMany({})` mỗi lần chạy → thay hẳn, không viết migration danh mục.

---

## 2. Blast radius

| Thay đổi | Kéo theo |
|---|---|
| `attributes` → `Mixed` | `listing.model`, `listing.schema`, `listing.service` (2 chỗ `new Map(Object.entries())`), `seed-bulk.ts` (3 chỗ), migration |
| Thêm `attrs` + `templateRef` | `listing.model` (2 index), `listingResponseSchema`, `toListing()` bên FE |
| `validateAttributes` vào service | `listing.service.create` + `.update`, test integration của listing |
| `Category.requireManualReview` | `category.model/schema/types`, `listing.service` (nguồn `autoApprove`), `admin-content.ts` FE |
| Endpoint template mới | `openapi.json` → `api:sync` FE → `src/api/generated/**` |
| Form động bên FE | `ListingForm.tsx` (252/350 LOC), `listingDraft.ts`, `client.ts` `toListingBody`, `db.ts` type `Listing` |
| Lọc theo attrs | `qk.search()` — key factory cố tình liệt kê từng field, xem §4.4 |

---

## 3. Backend — `docs/Vue`

Feature mới đặt tên **`category-template`**, đủ 7 layer theo `AGENT.md §Cấu trúc`. Không nhét
vào `features/category`: hai collection, hai vòng đời, và `category` hiện đang gọn.

### 3.1 Phase BE-1 — Model + hai collection *(nền, chưa ai thấy)*

```
src/features/category-template/
  category-template.model.ts       ← FieldDefinition + CategoryTemplate
  category-template.schema.ts      ← zod: fieldDefSchema, templateResponseSchema
  category-template.types.ts       ← toTemplateDto (resolve fieldKeys → field đầy đủ)
  category-template.validate.ts    ← hàm THUẦN, xem BE-3
  category-template.repository.ts
  category-template.service.ts
  category-template.controller.ts
  category-template.routes.ts
```

- **KHÔNG gắn `tenantPlugin`** — cùng lý do `Category` được miễn (từ điển dùng chung toàn hệ
  thống). Phải ghi thêm 2 dòng vào bảng §1.3 của `docs/rules/multi-tenant.convention.md`,
  nếu không rule 12 sẽ bắt lỗi ở lần review sau.
- Index: `field_definitions { key: 1 } unique` · `category_templates { categoryId: 1, version: -1 }`
  + `{ isFallback: 1, version: -1 }`.
- Hook `pre(/^find/)` **và** `pre('countDocuments')` loại `deletedAt` — khuôn của
  `category.model.ts`, rule 10.
- `status: 'draft' | 'published'`, `version` số nguyên. Không bao giờ update bản đã publish.

### 3.2 Phase BE-2 — `Listing` đổi hình

1. `attributes: { type: Map, of: Schema.Types.Mixed }`
2. `attrs: [{ k: String, v: Schema.Types.Mixed }]` + `templateRef: { id, version, isFallback }`
3. **Sinh `attrs` ở service, không phải hook `pre('save')`** — đặc tả §5.3 gợi ý hook, nhưng
   hook không đọc được template một cách đồng bộ, và `listingRepository.updateById()` dùng
   `findByIdAndUpdate` nên không kích hoạt `save` gì cả: tin sửa sẽ lặng lẽ giữ `attrs` cũ.
4. Hai index §0.3.
5. `listingResponseSchema` thêm `attributes` (`z.record(z.unknown())`) + `templateRef`.

### 3.3 Phase BE-3 — Validate

`category-template.validate.ts` — bám sát đặc tả §5.4: ép kiểu → kiểm `min/max` → kiểm option
→ **loại key lạ**. Ba việc đó là bề mặt test rõ nhất của cả tính năng → giữ nó **thuần** (nhận
template + raw, trả object đã sạch), service chỉ lo đi lấy template. Test ở `tests/unit/`,
không phải qua HTTP.

Nối vào `listing.service.create` (cạnh `categoryService.assertUsable`) và `.update`.

⚠️ `showIf`: field bị ẩn thì **không** validate `required` của nó. Hàm phải tự tính
`visibleFields` trước, cùng luật với FE — nếu không, tin xe đạp sẽ bị đòi `engineCc`.

### 3.4 Phase BE-4 — Endpoint

```
GET /categories/{id}/template     → template đã resolve, fallback nếu chưa có bản riêng
```

- Đặt ở `category-template.routes.ts`, mount dưới `/categories` — đường dẫn thuộc về danh mục,
  code thuộc về feature template.
- Đọc công khai, như `GET /categories`: màn tìm kiếm cũng cần template để dựng bộ lọc.
- `registerPath` bắt buộc (`api-contract.md §1`) — thiếu là endpoint không lên `/docs`.
- Response đã resolve sẵn `fieldKeys` → object đầy đủ (đặc tả §5.2), FE không gọi vòng hai.

### 3.5 Phase BE-5 — Lọc theo attrs

`listingQuerySchema` thêm `attrs?: string` dạng `k:v,k:v` (query string phẳng, dễ đưa vào
cache key FE). `buildFilter` dịch sang:

```js
filter.$and = pairs.map(([k, v]) => ({ attrs: { $elemMatch: { k, v } } }))
```

`$elemMatch` chứ không phải `attrs.k` + `attrs.v` rời — hai điều kiện rời sẽ match chéo giữa
hai phần tử khác nhau của mảng.

Giữ **rule 7**: `buildFilter` vẫn mặc định `status: ACTIVE`, đừng đụng dòng đó.

### 3.6 Phase BE-6 — Seed + migration

- `scripts/seed-templates.ts` — idempotent `updateOne(..., { upsert: true })` theo đặc tả §5.1,
  thứ tự: `field_definitions` → `categories` → `category_templates`.
- `scripts/migrate-attributes.ts` — ép kiểu `attributes` cũ theo template, sinh `attrs` +
  `templateRef` cho tin đã có. Bọc `runUnscoped('migrate attributes', ...)` (**rule 12d**).
- `scripts/seed.ts` cập nhật danh sách danh mục (dòng 182–185) sang 7 slug mới.

### 3.7 Phase BE-7 — Test + export

- `tests/unit/validateAttributes.test.ts` — ép kiểu, option lạ, key lạ, `showIf` bỏ qua required.
- `tests/integration/category-template.test.ts` — fallback khi chưa có template riêng, version
  mới nhất thắng, `POST /listings` với attributes sai → 400.
- `npm run lint && npm run typecheck && npm test` rồi `npm run openapi:export`.

---

## 4. Frontend — `docs/VueRoute`

### 4.0 Phase FE-0 — Gỡ chặn *(làm trước, nếu không mọi thứ sau đều mù type)*

Đổi tên `docs/Vue` → `docs/market` (§0.7), rồi `npm run api:sync`. Kiểm tra
`src/api/generated/types.gen.ts` đã có type template.

### 4.1 Phase FE-1 — Tầng dữ liệu

- `src/api/db.ts`: `Listing` thêm `attributes?: Record<string, unknown>`; type mới
  `TemplateField` + `CategoryTemplate` (đây là chỗ khai domain type theo AGENTS §Kiến trúc).
- `src/api/client.ts`: `toListing()` map `attributes`; `toListingBody()` gửi kèm — `client.ts`
  đã 688 dòng, hai hàm này là chỗ duy nhất được sửa.
- `src/queries/keys.ts`: `qk.categoryTemplate(categoryId)` — **HARD#3**, không array literal
  tại call-site.
- **`src/queries/templates.ts` (file mới)** — `useCategoryTemplate(categoryId)` với
  `enabled: categoryId.length > 0` (**HARD#5**) và `staleTime` dài như `useCategories`.
  Không nhét vào `listings.ts`: file đó đang 194/200 dòng, **HARD#11** vỡ ngay.

### 4.2 Phase FE-2 — Renderer form động

Đặc tả §5.5 viết bằng Vue (`<component :is>`). Bản RN tương đương: một record
`type → component` + dispatcher.

- Component mới `src/components/AttrFields.tsx` — nhận `fields` + `values` + `onChange`,
  tự lọc `showIf` và sort `order`.
- **Đọc `docs/conventions/folder.convention.md` TRƯỚC khi tạo file/thư mục (HARD#15).**
- Ánh xạ 7 `type`:

  | `type` | Dựng bằng |
  |---|---|
  | `text` / `textarea` | `Field` (`ui.tsx`) — đã có `multiline` |
  | `number` | `Field` + `keyboardType="number-pad"` + hậu tố `unit` |
  | `select` / `year` | `PickerSheet` — đã generic `<T extends string>`, dùng lại |
  | `multiselect` | Mới — nhóm `TapeChip` bật/tắt, không cần checkbox thật |
  | `boolean` | `Switch` của react-native |

- `ListingForm.tsx` chỉ thêm ~15 dòng: gọi `useCategoryTemplate(categoryId)` và chèn
  `<AttrFields>` dưới chip danh mục. Nó đang 252/350 dòng — mọi thứ nặng hơn phải ra file riêng.
- ⚠️ **Xoá giá trị khi field bị `showIf` ẩn** (đặc tả §5.5) — nếu không sẽ gửi `engineCc` cho
  một chiếc xe đạp. Chỗ đúng để làm: reducer state của `AttrFields`, không phải lúc submit.
- `listingDraft.ts` (`validateListingDraft`) thêm nhánh kiểm `required` của attrs — client
  validate phải khớp server (đặc tả Bước 4).

### 4.3 Phase FE-3 — Hiển thị

`app/listing/[id].tsx` đang **244/250 dòng (HARD#11)** → bảng thuộc tính bắt buộc là component
riêng `src/components/ListingAttrs.tsx`, route chỉ render một thẻ.

Chỉ hiện field có giá trị, hiện `label` + `option.label` (không phải `value` thô), kèm `unit`.

### 4.4 Phase FE-4 — Lọc theo attrs *(để sau cùng, chỉ khi đã đo là cần)*

`qk.search(f)` (`keys.ts`) cố tình liệt kê từng field thay vì `JSON.stringify` — vì thứ tự khoá
object không bảo đảm. Thêm attrs động phải giữ đúng tinh thần đó: serialize thành chuỗi
**đã sort** `k:v|k:v` rồi mới đưa vào key. Đây là điều kiện để hai bộ lọc giống nhau không
thành hai lượt gọi mạng.

`SearchFilterPanel.tsx` (139 dòng) chỉ dựng attrs khi `filter.categoryId !== null` — không có
danh mục thì không có template, không có gì để lọc.

### 4.5 Phase FE-5 — Quản trị

`app/admin/categories.tsx` (199 dòng) thêm một dòng meta trên mỗi thẻ: `TEMPLATE v2` hoặc
`DÙNG BẢN CHUNG`. Không thêm form (§0.4).

---

## 5. Thứ tự thi công

Đặc tả §VI xếp theo *độ khó nội dung*. Thứ tự dưới đây xếp theo *rủi ro kỹ thuật* — hạ tầng
trước, chứng minh bằng một template, rồi mới đổ nội dung.

| Bước | Việc | Repo | Chặn ai |
|---|---|---|---|
| 1 | §0.7 đổi tên thư mục + `api:sync` chạy được | FE | mọi bước FE |
| 2 | BE-1 → BE-4 + template **Khác (fallback)** | BE | — |
| 3 | FE-0 → FE-3 với fallback (4 field, không `showIf`) | FE | — |
| 4 | Template **Điện thoại** — test cả pipeline, vẫn chưa cần `showIf` | BE | — |
| 5 | BE-5 + FE-4 (lọc) — chỉ khi bước 4 đã chạy thật | cả hai | — |
| 6 | **Đồ gia dụng** → **Xe cộ** → **Đồ điện tử** (`showIf` thật) | BE | — |
| 7 | **Bất động sản** + `priceUnit` (§0.6) | cả hai | — |
| 8 | **Thú cưng** — chỉ sau khi đã đọc policy store | cả hai | §0.5 |

Bước 3 dừng lại được: fallback 4 field không bắt buộc là một tính năng hoàn chỉnh, tin vẫn đăng
được y như hôm nay.

---

## 6. Rủi ro

| Rủi ro | Dấu hiệu sớm | Cách chặn |
|---|---|---|
| Index `attrs` phình trên M0 512 MB | `db.stats()` sau seed | Kỷ luật `filterable` (§0.3); đo trước khi thêm field filterable thứ 8 |
| Validate FE và BE lệch nhau về `showIf` | Tin hợp lệ ở form nhưng 400 ở BE | Cùng một bảng luật, test cả hai chiều ở bước 4 |
| Template v2 làm hỏng tin v1 | Form sửa tin hiện field lạ | Đọc `templateRef.version` của tin, không phải bản mới nhất |
| Thú cưng bị gỡ app | — | §0.5, cửa đóng sẵn |
| `attributes` Mixed lọt kiểu lạ vào DB | — | `validateAttributes` là đường ghi **duy nhất**; không service nào khác ghi thẳng |

---

## 7. Xác minh

- **BE**: `npm run lint && npm run typecheck && npm test` (AGENT §Quy trình), rồi
  `npm run openapi:export` nếu có endpoint/schema đổi.
- **FE**: `npm run lint && npm run typecheck`. Repo này không có test runner.
- **Review**: FE commit dùng bypass đã ghi nhận
  `[skip-review: nested repo, reviewed via /review-diff-rn]` (AGENTS.md). BE theo `/review-diff`.
