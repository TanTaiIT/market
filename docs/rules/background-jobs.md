# Background Jobs – App đăng tin

## Nguyên tắc

**Những thứ "hết hạn" không nhất thiết cần job.** Lưu thời điểm hết hạn (ví dụ `boostedUntil`, `expiresAt`) và lọc trong truy vấn bằng `> now()`. Trạng thái tự đổi đúng giờ mà không cần job nào chạy. Chỉ dùng job khi phải **thực hiện một hành động**: gửi thông báo, gọi dịch vụ bên ngoài, dọn dữ liệu.

Hai loại job:

- **Cron (định kỳ):** chạy theo lịch (mỗi giờ, mỗi đêm...).
- **Queue (hàng đợi):** chạy khi có sự kiện, xử lý bất đồng bộ và tự thử lại khi lỗi.

---

## 1. Job cần có ngay từ đầu (MVP)

| Job | Loại | Tần suất | Mô tả |
|---|---|---|---|
| Gửi push notification | Queue | Theo sự kiện | Gửi thông báo tin nhắn mới, có người hỏi mua. Đưa vào hàng đợi để API không phải chờ, tự gửi lại nếu lỗi. |
| Hủy đơn thanh toán quá hạn | Cron | 5–10 phút | Đơn VietQR không thanh toán sau 15–30 phút thì chuyển sang trạng thái hủy. |
| Đối soát thanh toán | Cron | 15–30 phút | Phòng trường hợp webhook ngân hàng (Casso, SePay) bị lỡ. Chủ động kiểm tra lại giao dịch để không có khách đã trả tiền mà chưa được kích hoạt gói. |
| Nhắc tin sắp hết hạn | Cron | Mỗi ngày | Thông báo người đăng gia hạn tin. Việc hết hạn dùng timestamp, không cần job. |
| Nhắc gói sắp hết hạn | Cron | Mỗi ngày | Thông báo trước vài ngày để người dùng gia hạn gói. |
| Xóa ảnh khi xóa hoặc sửa tin | Queue | Theo sự kiện | Xóa ảnh trên R2 bất đồng bộ, tự thử lại khi lỗi mạng. Không cần job đối soát ảnh rác. |
| Dọn phiên đăng nhập hết hạn | Cron | Mỗi ngày | Xóa session đã hết hạn hoặc đã thu hồi để bảng không phình to. |

---

## 2. Job nên thêm khi phát triển

| Job | Loại | Tần suất | Mô tả |
|---|---|---|---|
| Thông báo tìm kiếm đã lưu | Cron | Mỗi giờ | Báo người dùng khi có tin mới khớp với tìm kiếm đã lưu. Tính năng giữ chân người dùng hiệu quả. |
| Tự động đẩy tin | Cron | Mỗi giờ | Đẩy tin của người bán chuyên nghiệp theo lịch họ đã cài (thuộc gói chuyên nghiệp). |
| Gửi thông báo hàng loạt cho group | Queue | Theo sự kiện | Admin group gửi thông báo tới nhiều thành viên. Chia thành từng lô nhỏ để tránh quá tải. |
| Kiểm tra tin spam, lừa đảo | Queue | Khi có tin mới | Phát hiện tin trùng lặp, từ khóa cấm, số điện thoại trong danh sách đen. |
| Cộng dồn lượt xem | Cron | 5–15 phút | Gom lượt xem rồi ghi một lần, thay vì cập nhật database mỗi lần có người xem tin. |
| Tạo sitemap cho website | Cron | Mỗi ngày | Giúp Google tìm thấy tin đăng mới (phục vụ SEO). |
| Xuất hóa đơn điện tử | Queue | Sau mỗi thanh toán | Gọi nhà cung cấp hóa đơn điện tử, tự thử lại nếu lỗi. |
| Thống kê và báo cáo | Cron | Mỗi đêm | Tổng hợp số liệu cho trang quản trị: doanh thu, tin mới, người dùng mới. |
| Tính tiền ăn chia cho admin group | Cron | Mỗi tháng | Áp dụng nếu dùng mô hình chia doanh thu với admin group. |
| Xóa dữ liệu theo yêu cầu | Queue | Theo yêu cầu | Khi người dùng yêu cầu xóa tài khoản: xóa dữ liệu cá nhân, ảnh, tin nhắn theo quy định bảo vệ dữ liệu. |

---

## 3. Những thứ không cần job

| Trường hợp | Cách xử lý |
|---|---|
| Ảnh rác do upload rồi bỏ đi | Lifecycle rule của R2 tự xóa file trong `temp/` sau 1 ngày. |
| Tin, gói, tin nổi bật hết hạn | Lưu timestamp và lọc trong truy vấn. |
| Sao lưu database | Dịch vụ PostgreSQL có quản lý (Neon, Supabase, Azure...) thường tự sao lưu. |

---

## 4. Công cụ đề xuất

- **pg-boss** hoặc **Graphile Worker**: dùng chính PostgreSQL làm hàng đợi, hỗ trợ cả cron và queue, có thử lại khi lỗi, **không cần thêm Redis**.
- **BullMQ** (dùng Redis): chỉ cân nhắc khi hệ thống lớn tới mức hàng đợi trên PostgreSQL trở thành nút thắt.

**Tránh** dùng `setInterval` hoặc `node-cron` chạy trong server API. Khi chạy nhiều instance, job sẽ bị chạy trùng (ví dụ gửi thông báo hai lần), và job đang chạy sẽ mất khi server khởi động lại.
