# ADR: Hệ Xu — tiền tệ nội bộ tính phí đăng tin

**Trạng thái**: chuẩn bị (giai đoạn miễn phí đang chạy, phí = 0). Ngày bật phí do chủ dự án
quyết — tài liệu này tồn tại để ngày đó KHÔNG cần thiết kế lại gì, chỉ thực thi.

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
wallets           { userId unique, balance (CACHE), version }   ← CAS như UserTrust
xu_transactions   { userId, amount(±), type, balanceAfter,
                    refs{listingId|paymentId}, idempotencyKey unique, createdAt }
type ∈ topup · post_fee · refund · promo_grant · admin_adjust
```

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

1. **Ví nhìn được**: collections + `GET /wallet` + lịch sử + master tặng/điều chỉnh
   (`admin_adjust` kèm lý do) + notify biến động. Số dư ai cũng 0 — FE xây màn ví.
2. **Nạp**: collection `payments` + một cổng (khuyến nghị khởi đầu: VietQR + webhook đối
   soát, hoặc MVP chuyển khoản → master cộng tay bằng `admin_adjust`). Webhook bắt buộc
   idempotent.
3. **Bật phí**: `POST_FEE > 0` (chuyển sang config master sửa được) → trừ trong transaction
   cùng lệnh tạo tin → thiếu Xu trả `402` dẫn tới màn nạp → nối hoàn-Xu vào
   `setListingStatus`/máy quét theo bảng §3 → `promo_grant` toàn bộ user hiện hữu.

## 5. Điều kiện bật phí (checklist ngày đó)

- [ ] posting-stats có tối thiểu ~2 chu kỳ 30 ngày dữ liệu để định giá
- [ ] Giai đoạn 1 + 2 đã chạy ổn (ví + nạp), có người nạp thật
- [ ] Điều khoản sử dụng có mục Xu (một chiều, không hoàn tiền mặt, luật hoàn Xu §3)
- [ ] Test canary trong `listingPricing.test.ts` được sửa CÓ Ý THỨC cùng lượt đổi giá
