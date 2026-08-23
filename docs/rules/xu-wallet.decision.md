# ADR: Hệ Xu — tiền tệ nội bộ tính phí đăng tin

**Trạng thái**: giai đoạn 1 (ví) ĐÃ XÂY; giai đoạn 2 (nạp) đã dựng rồi gỡ bỏ — xem §4.2. Phí đăng tin vẫn = 0. Ngày bật phí do
chủ dự án quyết — tài liệu này tồn tại để ngày đó KHÔNG cần thiết kế lại gì, chỉ thực thi.

## 1. Bối cảnh

Đăng tin đang miễn phí có chủ đích để thu hút người dùng. Khi đủ đông, mỗi lượt đăng sẽ trả
bằng **Xu** — đơn vị tiền nội bộ người dùng nạp VND để mua. Chuẩn bị được đổ từ trước:

- `listing.pricing.ts` — luật phí thuần, một chỗ duy nhất (`postingFee`), hiện trả 0.
- Hợp đồng API đã mang `fee` từ hôm nay: `GET /listings/quota` (kèm quota) và `meta.fee`
  của `POST /listings`. FE hiển thị "Miễn phí" ngay bây giờ; ngày bật phí là con số đổi,
  không phải API mới làm gãy app cũ trên máy khách.
- `GET /listings/posting-stats` (master) — dữ liệu ĐỊNH GIÁ tích luỹ từ giai đoạn miễn phí:
  tổng lượt đăng, số người đăng, phân bố danh mục, biểu đồ ai-đăng-bao-nhiêu.

## 2. Kiến trúc đã chốt (xây ở giai đoạn 1–3, KHÔNG xây bây giờ)

**Sổ cái, không phải con số.** Cấm `user.xu` cộng trừ tại chỗ. Hai collection, cả hai
tenant-exempt (tài khoản là toàn cục — cùng lý do với `UserTrust`, cần bổ sung vào
multi-tenant.convention §1.3 khi xây):

```
wallets           { userId unique, balance (CACHE) }
xu_transactions   { userId, amount(±), type, balanceAfter,
                    refs{listingId|paymentId|productCode}, idempotencyKey unique, createdAt }
type ∈ topup · post_fee · product_purchase · refund · promo_grant · admin_adjust
```

**Đã xây, có một khác biệt so với thiết kế ban đầu**: bỏ field `version`/CAS — Mongo chạy
replica set nên `$inc` nguyên tử bên trong một transaction vừa gọn hơn vừa chặt hơn CAS thủ
công. Đổi lại, hạ tầng BẮT BUỘC là replica set (Atlas mặc định có; dev local cần `--replSet`).

Bất biến:
1. Sổ cái append-only — sai thì ghi dòng điều chỉnh ngược dấu, không sửa/xoá.
2. Mọi biến động đi qua đúng MỘT hàm (`walletService.apply`), có idempotencyKey.
3. "Trừ Xu + tạo tin" chạy trong một transaction Mongo (replica set đã sẵn).
4. **Xu một chiều**: nạp vào được, không quy đổi ngược ra tiền — giữ nền tảng ngoài phạm
   vi giấy phép trung gian thanh toán; ghi rõ trong điều khoản sử dụng.

## 3. Chính sách đã quyết

| Tình huống | Quyết định | Vì sao |
| --- | --- | --- |
| Tin bị **từ chối** khi duyệt | **Hoàn Xu** | Trả phí để *được đăng*, không phải để xếp hàng; giảm hẳn khiếu nại |
| Tin bị **gỡ sau khi lên bảng** | Không hoàn | Đã hưởng dịch vụ; là hình phạt cùng họ với trừ uy tín |
| Cổng nội dung chặn từ cửa (`content_banned`) | Không trừ ngay từ đầu | Chỉ trừ khi tin vào `PENDING`/`ACTIVE` |
| Xu có hạn sử dụng | **Không** | Xu hết hạn là nguồn khiếu nại số một, không đáng |
| Uy tín cao giảm phí | Để ngỏ | Hook sẵn trong `postingFee` (`trustLevel`) |
| Giá theo danh mục | Để ngỏ | Hook sẵn (`categoryId`); quyết bằng số liệu posting-stats |
| Miễn phí N tin/tháng sau khi bật | Nên có | Chuyển tiếp mềm cho người dùng vãng lai |
| Tặng Xu khai trương cho user hiện hữu | Có (`promo_grant`) | Ngày bật phí phải là ngày nhận quà |

## 4. Lộ trình

1. ~~**Ví nhìn được**~~ ✅ ĐÃ XONG: `GET /wallet`, `GET /wallet/transactions`,
   `POST /wallet/{userId}/adjust` (master, `note` + `idempotencyKey` bắt buộc), notify biến
   động cho các loại người dùng không tự bấm ra.
2. **Nạp** — CHƯA XÂY. Đã dựng một lần rồi **gỡ bỏ có chủ ý** (2026-08-23): hệ thống chưa có
   nhu cầu quét tiền thật, và giữ code thanh toán không dùng tới là giữ một mặt tấn công
   không ai canh. Bản đã gỡ gồm: `POST /payments/topup` (sinh mã đối soát + ảnh QR
   `img.vietqr.io`), `GET /payments/{id}` cho client poll, `POST /payments/{id}/confirm` cho
   master xác nhận tay, webhook VietQR.vn hai chiều (`/api/token_generate` +
   `/bank/api/transaction-sync`), bảng `bank_transactions` làm nhật ký đối soát kiêm hàng đợi
   khớp tay, và `scripts/simulate-vietqr.ts` để test không cần tiền thật.

   **Những gì học được, giữ lại để khỏi phải phát hiện lần nữa** khi dựng lại:
   - Tiền tố mã đối soát KHÔNG được là `NAP`: bỏ dấu xong thì chữ "nạp" mà người Việt luôn gõ
     trong nội dung chuyển khoản cũng thành `NAP`, bộ dò bắt nhầm ngay giao dịch đầu tiên.
     Dùng tên ứng dụng (`GHIM`) và trả về DANH SÁCH ứng viên để phép tra DB làm trọng tài.
   - VietQR gồm hai thứ khác nhau: `img.vietqr.io` sinh ảnh QR miễn phí không cần đăng ký, còn
     `api.vietqr.org` (VietQR JSC + MB) mới là dịch vụ đối soát — có sandbox `dev.vietqr.org`
     kèm API mô phỏng callback, test được webhook mà không cần một đồng tiền thật.
   - Webhook của họ bắt merchant tự dựng CẢ endpoint `token_generate` (Basic → Bearer), không
     phải chỉ kiểm một API key như SePay.
   - `transType: D` là tiền RA — cộng Xu cho nó là biếu không tiền cho người vừa rút.
   - Giao dịch đã xử lý rồi mà trả `error: true` là tự tạo vòng lặp retry vô tận của họ.
   - Cộng Xu theo số tiền THẬT nhận được, không theo số tiền đơn hẹn.

   Code đã gỡ còn trong git history của phiên làm việc; dựng lại thì bắt đầu từ các bài học trên.
3. **Bật phí**: `POST_FEE > 0` (chuyển sang config master sửa được) → trừ trong transaction
   cùng lệnh tạo tin → thiếu Xu trả `402` dẫn tới màn nạp → nối hoàn-Xu vào
   `setListingStatus`/máy quét theo bảng §3 → `promo_grant` toàn bộ user hiện hữu.

## 5. Điều kiện bật phí (checklist ngày đó)

- [ ] posting-stats có tối thiểu ~2 chu kỳ 30 ngày dữ liệu để định giá
- [ ] Giai đoạn 1 + 2 đã chạy ổn (ví + nạp), có người nạp thật
- [ ] Điều khoản sử dụng có mục Xu (một chiều, không hoàn tiền mặt, luật hoàn Xu §3)
- [ ] Test canary trong `listingPricing.test.ts` được sửa CÓ Ý THỨC cùng lượt đổi giá

## 6. Gói tin — sản phẩm mua bằng Xu áp lên một tin

**Ghi chú chiến lược**: gói tin là doanh thu KHÔNG phạt người dùng cơ bản — đăng tin có thể
miễn phí mãi, ai muốn nổi hơn thì trả. Lộ trình vì thế có phương án đảo: **ví → nạp → gói
tin** trước, phí đăng để ngỏ vô thời hạn. Ngày bật gói tin không ai giận; ngày bật phí đăng
luôn có người bỏ đi.

Catalog sống trong DB (`ListingProduct`, tenant-exempt) — master xuất bản/sửa/ngừng bán qua
`/listing-products` (CRUD, master-only), tạo được nhiều mốc ưu đãi (`featured_7d_sale`…) mà
không cần deploy. `GET /listings/products` công khai CHỈ trả gói đang `enabled`. Luật cứng:
mở bán phải có giá; `code` bất biến (sổ cái tham chiếu bằng nó — đổi bản chất gói = tạo gói
mới, ngừng bán gói cũ); mua rồi thì sổ cái snapshot điều khoản, sửa gói không viết lại lịch
sử. Bộ khởi điểm seed bằng `npm run seed:listing-products` (idempotent, không đè bản master
đã sửa); `DEFAULT_LISTING_PRODUCTS` trong `listing.pricing.ts` từ nay CHỈ là seed.

| Gói | Hiệu ứng | Cơ chế đã chuẩn bị |
| --- | --- | --- |
| `bump` — Đẩy tin | `rankAt = now` → tin lên đầu bảng | `rankAt` là khoá sắp xếp MỚI của mọi bảng tin (= `createdAt` lúc tạo). Không sửa `createdAt` — đó là lịch sử |
| `featured_3d/7d` — Tin nổi bật | `featuredUntil = now + N ngày`, FE suy badge từ `> now` | Field đã có trong model + DTO |
| `extend_30d` — Gia hạn | `expiresAt += 30 ngày` | TTL 30 ngày sẵn có |

Chính sách đã quyết:

| Tình huống | Quyết định |
| --- | --- |
| Điều kiện mua | Tin `ACTIVE` + của chính mình — gói tin là HIỂN THỊ, không phải đường tắt qua duyệt |
| Chống spam đẩy | Cooldown 24h/tin (khai trong catalog) — chặn cả nhà giàu chiếm bảng |
| Tin nổi bật bị sửa → về `PENDING` (chốt tái duyệt) | Đồng hồ chạy tiếp — sửa là lựa chọn của người bán; UI cảnh báo trước |
| Tin nổi bật bị gỡ vì vi phạm | Không hoàn Xu — nhất quán §3 |
| Tin hết hạn khi đang nổi bật | Hết là hết; muốn thì mua gia hạn, không tự trừ tiền |
| Đẩy tin có chen hàng DUYỆT không | KHÔNG — index hàng đợi (unitId, machineReview) giữ `createdAt`, FIFO theo lúc đăng thật |
| Sổ cái | Thêm type `product_purchase` (refs: `listingId` + mã gói) vào enum §2 |

Đường mua (xây ở giai đoạn ví): `POST /listings/{id}/products/{code}` — trừ Xu trong
transaction cùng lượt áp hiệu ứng; badge hạ tự nhiên theo `featuredUntil` (không cần cron).

**Vận hành khi deploy bản chuẩn bị**: chạy `npm run migrate:rank-at` NGAY sau deploy —
backfill `rankAt = createdAt` cho tin cũ + đồng bộ họ index. Chưa chạy thì tin cũ chìm xuống
đáy bảng (BSON xếp field vắng mặt nhỏ hơn mọi Date).
