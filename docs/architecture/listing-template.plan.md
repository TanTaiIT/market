# Template đăng tin theo danh mục — phân tích & kế hoạch

> Kế hoạch thi công trên code hiện có (`docs/market` Express + Mongoose, `docs/VueSer` Expo RN).
> Không lặp lại phần nghiệp vụ. Đọc `v2-org-permission.plan.md` trước nếu chưa quen hai trục.

## 0. Hiện trạng — một nửa đã có sẵn

| Thứ | Trạng thái |
| --- | --- |
| `Listing.attributes: Map<string, string>` | **Đã có** trong model + `createListingSchema` (`z.record(z.string())`) |
| Ghi `attributes` lúc tạo tin | **Đã chạy** — `listing.service.toListingDoc` |
| Trả `attributes` trong response | **Đã có** — `listingResponseSchema` dùng `.passthrough()` |
| App đọc `attributes` | **KHÔNG** — `grep attributes src/ app/` trong VueSer trả về rỗng |
| Mô tả field của từng danh mục | **Chưa có** — `Category` chỉ có `name/slug/icon/order/isActive` |
| Lọc theo attribute | **Chưa có** — `buildFilter` chỉ có category/seller/condition/province/price/`q` |

Nghĩa là: **kho chứa đã xong và đang nhận dữ liệu, nhưng không ai mô tả nó và không ai đọc nó.**
Việc cần làm không phải "thêm chỗ lưu", mà là "thêm bản mô tả + đường đọc".

Bốn danh mục seed hiện tại: `Sách vở` · `Xe đạp` · `Điện tử` · `Đồ dùng`. `Đồ dùng` đang đóng
vai danh mục chung — mọi cảnh báo về "tin khác phình to" áp vào chính nó.

---

## 1. Ba điều chỉnh so với bản đề xuất

### 1.1 `condition` KHÔNG được nằm trong template

Bản đề xuất đưa `{ "key": "condition", "type": "radio", "label": "Tình trạng" }` vào schema. Nhưng
`LISTING_CONDITION` (`new | like_new | used`) **đã là cột hạng nhất** của `Listing` và **đã lọc
được** trong `buildFilter`. Đưa nó vào template là tạo hai nguồn sự thật cho cùng một dữ kiện: tin
cũ lọc bằng cột, tin mới lọc bằng attribute, và bộ lọc chẻ làm hai.

**Luật rút ra:** template chỉ mô tả thứ **riêng của một danh mục**. Cái gì cắt ngang mọi danh mục —
giá, tình trạng, khu vực, ảnh, tiêu đề — ở lại làm cột thật. Trước khi thêm một field vào template,
hỏi: "field này có nghĩa với hơn một nửa số danh mục không?" Có → nó là cột, không phải attribute.

### 1.2 "JSONB + index từng field filterable" cần dịch sang Mongo, và tạm thời **đừng index**

Đây là Mongo, không phải Postgres — `attributes` là Map, index được trực tiếp `attributes.brand`.
Nhưng ba chi tiết làm đổi kết luận:

1. `Listing` chạy **hai trục index** song song (`{organizationId, …}` và `{visibility, …}`). Mỗi
   attribute muốn index đầy đủ là **hai** index, không phải một.
2. Rule 13 của `AGENT.md` buộc mọi index trên collection có tenant lấy `organizationId` làm khoá
   đầu. Index wildcard (`attributes.$**`) không đặt được như vậy → muốn dùng phải **sửa rule
   trước**, không lách.
3. Compound wildcard index cần MongoDB **7.0+**. Phải kiểm phiên bản cluster Atlas trước khi thiết
   kế dựa vào nó.

**Chốt cho vòng này: không thêm index nào cho attribute.** Lý do: bộ lọc attribute **luôn** đi sau
một bộ lọc danh mục (không ai lọc "dung lượng" mà chưa chọn "Điện tử"). Index
`{visibility, category, provinceCode, status, createdAt}` đã có sẵn thu hẹp về vài trăm document;
lọc attribute trong phạm vi đó không phải chỗ nghẽn. Thêm index khi **đo được** một danh mục đủ lớn,
không thêm trước.

### 1.3 Danh mục con: đặt cột bây giờ, viết logic kế thừa sau

Đề xuất lấy bất động sản làm ví dụ (bán/cho thuê × căn hộ/nhà/đất). Đây là **chợ đồ cũ trong tổ
chức** — 4 danh mục hiện tại là sách/xe đạp/điện tử/đồ dùng, và `orgType` mở rộng nhất cũng chỉ tới
`company | community`. Bất động sản không nằm trong tầm nhìn gần.

Hệ quả: nhu cầu **lọc theo khoảng** (diện tích 45–70m², số phòng ngủ) gần như biến mất. Sách không
có, đồ dùng không có; điện tử thì dung lượng/RAM đều là danh sách đóng.

Nhưng `Category` **chưa có `parentUnitId`/`parentId`** nào cả, và thêm cột vào một collection đã có
dữ liệu tốn hơn thêm ngay từ đầu. Nên:

- **Làm ngay:** thêm `Category.parentId: ObjectId | null`. Một cột nullable, không logic.
- **Hoãn:** hàm gộp template cha→con. Nó chỉ ~20 dòng (merge theo `key`, con ghi đè cha); phần đắt
  là UI quản lý cây danh mục. Viết khi có danh mục thứ hai thật sự cần.

---

## 2. Hai quyết định kỹ thuật phải chốt trước khi code

### 2.1 Kiểu giá trị: `Map<string, string>` hay `Map<string, Mixed>`

| | Giữ `string` | Đổi sang `Mixed` |
| --- | --- | --- |
| Lọc bằng nhau / `$in` | ✅ | ✅ |
| Lọc khoảng (`$gte/$lte`) | ❌ — `"128GB" < "64GB"` theo thứ tự chữ | ✅ |
| Sắp xếp theo attribute | ❌ | ✅ |
| Rủi ro | — | Cùng một key mang hai kiểu ở hai document |

**Đề xuất: đổi sang `Mixed`, ép kiểu theo `type` của template lúc ghi.** Rủi ro lệch kiểu được
chính template khử: nó là nơi DUY NHẤT quyết định coerce, nên không có đường nào ghi sai kiểu.

Kèm một luật vận hành phải viết vào code: **field trong template là append-only.** Đổi `type` của
một field đang dùng (vd `select` → `number`) sẽ để lại document cũ mang kiểu cũ, và truy vấn khoảng
**im lặng bỏ qua** chúng. Muốn đổi kiểu → dùng `key` mới.

### 2.2 Template lưu ở đâu

Nhúng vào `Category.template` (mảng field def), **không** tách collection riêng: template nhỏ
(5–15 field), luôn đọc cùng danh mục, tách ra chỉ thêm một lượt join.

Nhưng `GET /categories` bị gọi rất nhiều (hàng chip bảng tin). Nên: **loại `template` khỏi response
danh sách** (`.select('-template')`), chỉ trả ở `GET /categories/:id`. Màn đăng tin và màn lọc đều
đã biết mình đang ở danh mục nào nên gọi bản chi tiết là đủ.

### 2.3 "Dùng chung validate FE/BE" — bản khả thi ở repo này

FE và BE là hai repo riêng, nối bằng codegen; **không chia sẻ được code runtime** mà không dựng một
package chung. Thứ dùng chung được là **chính bản template**: BE lưu nó, FE tải nó về rồi render +
validate từ đó, BE validate lại cũng từ nó. Một nguồn dữ liệu, hai lần hiện thực — chấp nhận được,
vì template là *dữ liệu*, không phải *code*.

---

## 3. Hình dạng template

```ts
type TemplateField = {
  key: string                    // định danh trong `attributes`, snake_case, append-only
  label: string                  // nhãn tiếng Việt hiện trên form
  type: 'select' | 'text' | 'number' | 'boolean'
  options?: string[]             // bắt buộc khi type='select'
  unit?: string                  // 'GB' | 'inch' | 'km' — hiện cạnh ô nhập, KHÔNG lưu vào giá trị
  required?: boolean
  filterable?: boolean           // được phép xuất hiện trong query lọc
  order: number
}
```

Ba điều cố ý **không** có:

- **`type: 'date'`** — chưa danh mục nào cần, và date trong Map là nguồn lệch timezone. Thêm khi có ca thật.
- **`validate` dạng biểu thức/regex** — mở đường cho logic sống trong dữ liệu, và FE/BE sẽ hiện
  thực khác nhau. Ràng buộc chỉ gồm: `required`, `options`, và min/max của `number`.
- **`dependsOn`** (field hiện theo field khác) — đây là logic, không phải mô tả. Cần thì tách danh mục con.

### Trần bắt buộc — chốt bằng code, không bằng thiện chí

Mỗi field `required` là một điểm rơi trong phễu đăng tin. Đặt trần **tối đa 3 field `required`**
mỗi danh mục, và validate ngay lúc lưu template (không phải lúc đăng tin) — vượt trần thì từ chối
với thông điệp rõ. Người thêm danh mục sẽ không tự nhớ, mà lúc phát hiện thì phễu đã tụt.

Phần còn lại optional, kèm huy hiệu **"Tin đầy đủ thông tin"** tính từ tỉ lệ field đã điền — động
lực dương thay vì bắt buộc.

---

## 4. Kế hoạch theo phase

Thứ tự này có chủ ý: **Phase 4 là chỗ trả tiền cho ba phase trước.** Nếu dừng ở Phase 3 thì template
chỉ để vẽ trang chi tiết cho đẹp, và công sức không đáng — đúng như bản đề xuất đã cảnh báo.

### Phase 1 — Bản mô tả + đường ghi (chưa đổi UI)

| Việc | File |
| --- | --- |
| `Category.template: TemplateField[]`, `parentId: ObjectId \| null` | `category.model.ts` |
| Zod cho template + trần 3 `required` | `category.schema.ts` |
| Loại `template` khỏi response danh sách, trả ở bản chi tiết | `category.service.ts` |
| `attributes` → `Map<string, Mixed>` | `listing.model.ts` |
| Validate + coerce `attributes` theo template của danh mục đang chọn | `listing.service.ts` |
| Seed template cho 4 danh mục | `scripts/seed.ts` |
| Test: field lạ bị chặn · thiếu `required` → 400 · coerce đúng kiểu | `tests/integration/` |

Chốt quan trọng ở phase này: **attribute không khai trong template thì bị từ chối**, không lưu lặng
lẽ. Chấp nhận key tự do là quay về free-text với thêm mấy bước.

### Phase 2 — Form đăng tin render động

- `GET /categories/:id` trả template → app fetch khi người dùng chọn danh mục.
- Một `<DynamicFields schema={template} value={attributes} onChange={...} />` trong `ListingForm`,
  đặt sau hàng chọn danh mục.
- 4 component con theo `type`. `select` dùng lại `PickerSheet`/chip đã có, không viết mới.
- Đổi danh mục → xoá `attributes` đang có (field của danh mục cũ vô nghĩa ở danh mục mới) và
  **nói cho người dùng biết** thay vì xoá lặng lẽ.
- LOC: `ListingForm` đang 268/350 — `DynamicFields` phải là file riêng.

### Phase 3 — Trang chi tiết hiện bảng thông số

Bảng `label: value` theo `order` của template, bỏ field rỗng. `unit` ghép lúc hiển thị.
Rẻ, và là chỗ đầu tiên người dùng thấy lợi ích.

### Phase 4 — Lọc theo attribute (phase quyết định giá trị)

- `listingQuerySchema` nhận `attrs` dạng object. **Hai chốt bắt buộc:**
  1. Chỉ nhận khi có `category` — không có danh mục thì không có template để đối chiếu.
  2. Chỉ nhận key có `filterable: true` trong template của đúng danh mục đó. Key lạ → 400, không
     bỏ qua. Thiếu chốt này thì client lọc được bằng key bất kỳ: vừa quét toàn bảng, vừa thành
     đường dò dữ liệu.
- `buildFilter` dịch sang `{ 'attributes.brand': 'Apple' }`, số thì `$gte/$lte`.
- App: `SearchFilterPanel` render thêm nhóm lọc từ template của danh mục đang chọn — chọn danh mục
  mới thì nhóm đó đổi theo.
- **Chưa thêm index.** Đo `explain()` trên dữ liệu thật trước (xem §1.2).

### Phase 5 — Danh mục chung: đo và di dời

- **Không cần dựng log mới.** Tiêu đề tin đã nằm sẵn trong DB: một truy vấn
  `Listing.find({ category: <đồ dùng> }).select('title')` là đủ để biết nên mở danh mục nào tiếp.
  Dựng pipeline log riêng cho việc này là làm lại thứ đã có.
- Cơ chế chuyển danh mục **đã có một nửa**: `PATCH /moderation/listings/:id/route` đang đổi được
  `categoryId` (master dùng để chuyển ô ở trục công khai). Phase này chỉ cần thêm bước map
  `attributes` cũ → template mới, và cho phép bỏ trống field mới chưa có dữ liệu.

### Phase 6 — Hoãn có chủ ý

Kế thừa template cha→con · `type: 'date'` · min/max động · index attribute. Mỗi cái mở khi có một
ca thật đòi, không mở trước.

---

## 5. Cái giá đã biết

1. **Đổi `attributes` sang `Mixed`** làm mất kiểm tra kiểu ở tầng Mongoose — template trở thành lớp
   bảo vệ duy nhất. Bù bằng test cho bước coerce.
2. **Template là dữ liệu** nên sửa được lúc chạy, tức là sửa sai cũng lúc chạy. Cần chốt ai được
   sửa (hiện `POST/PATCH /categories` là master-only — giữ nguyên) và log lại thay đổi.
3. **Danh mục đổi template không hồi tố tin cũ.** Tin đăng trước khi thêm field mới sẽ thiếu field
   đó vĩnh viễn. Đây là lý do trang chi tiết phải bỏ field rỗng thay vì hiện "—".
4. **Phase 1–3 không tự trả giá trị.** Chúng chỉ đổi tin từ "một đoạn văn" thành "một bảng đẹp".
   Kế hoạch này chỉ đáng làm nếu Phase 4 chắc chắn được làm.
