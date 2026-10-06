# Đánh giá độ ổn định của hệ đang chạy

Ngày đánh giá: 06/10/2026. Đối tượng: backend `docs/market`.

Đánh giá dựa trên ba nguồn: chạy trọn bộ kiểm thử, bản audit ngày 26/09/2026, và đọc mã nguồn tại các điểm nghi vấn. Không có số liệu từ môi trường thật, nên "ổn định" ở đây nghĩa là được kiểm thử phủ kỹ và audit đã xử lý, không phải đã chạy êm trên production.

## Kết quả chạy kiểm thử

| Chỉ số | Giá trị |
|---|---|
| File kiểm thử | 123 (99 tích hợp, 24 đơn vị) |
| Ca kiểm thử | 1.293 |
| Đạt | 1.292 |
| Hỏng | 1 |
| Thời gian chạy | khoảng 8 phút |

Ca hỏng duy nhất là `tests/unit/imageUrlCloud.test.ts`, ca "từ chối ảnh của cloud khác, dù host đúng". Đây là lỗi thật, không phải lỗi môi trường: hàm kiểm URL ảnh trong `src/common/utils/imageUrl.ts` chỉ chốt host `res.cloudinary.com`, không chốt cloud name. Docblock của chính hàm đó và audit mục 1.16 đều ghi là đã chốt cloud name. Hệ quả là ảnh từ một tài khoản Cloudinary lạ vẫn lọt vào bảng tin. Khả năng cao phần sửa bị mất trong một lần merge gần đây; cần kiểm lại lịch sử commit của file này.

## Bản audit 26/09/2026

| Trạng thái | Số mục |
|---|---|
| Đã xử lý, có kiểm thử đi kèm | 88 |
| Bỏ qua có chủ ý (KYC tạm thời, Google login, quyết định sản phẩm) | 7 |
| Hoãn (tách god file, hạ tầng kiểm thử) | 2 |
| Tổng | 97 |

## Ba cụm ổn nhất

1. **Duyệt tin và định tuyến.** Được kiểm kỹ nhất: hàng đợi trục công khai, ma trận gỡ tin và uy tín, máy trạng thái duyệt, định tuyến hai trục, máy duyệt, cổng cụm cấm, sửa tin phải duyệt lại. Hơn 250 ca, nhiều ca là ma trận đủ tổ hợp. Cả 20 phát hiện của audit mục 1 đã sửa.
2. **Phân quyền và cách ly dữ liệu.** Chính sách quyền 42 ca, quét IDOR 25 ca, cách ly tenant, đọc xuyên nhiều nhóm, đọc tin theo quan hệ. Hai lỗ nặng của audit (hàng đợi công khai lộ tin nội bộ, tài khoản bị khoá vẫn ghi được) đã bịt và có kiểm thử chốt.
3. **Uy tín, hạn mức và quản chế.** Hạn mức 29 ca, công bằng uy tín 15 ca, chính sách uy tín 14 ca, quản chế 9 ca, khôi phục uy tín 6 ca, trần tin sống. Phần lớn là hàm thuần nên chạy nhanh và không phụ thuộc thứ tự.

## Ổn, còn vài góc chưa khép

| Cụm | Kiểm thử | Nhận xét |
|---|---|---|
| Nhóm và thành viên | khoảng 130 ca | Vòng đời nhóm, đơn xin vào, lời mời, khoá nhóm có cascade. Bốn mục audit bỏ qua có chủ ý, đều về KYC tạm thời |
| Tài khoản và phiên | khoảng 80 ca | Xoay refresh token, đổi mật khẩu, xoá tài khoản có cascade mới làm cuối tháng 9 |
| Tin đăng | khoảng 120 ca | Hết hạn, chống đăng đôi, đăng lại, template thuộc tính. Tìm kiếm toàn văn chưa có |
| Nhắn tin, hỗ trợ, thông báo | khoảng 80 ca | Chưa có chặn người, hoãn có chủ ý |

## Chưa thể gọi là ổn

- **Ảnh và upload.** Có ca kiểm thử hỏng nêu ở trên.
- **Công việc nền.** Audit mục 0.13 phát hiện mọi job đã chết im lặng trong thời gian dài vì lệch phiên bản driver MongoDB. Đã sửa ngày 26/09 và có kiểm thử, nhưng chưa có bằng chứng chạy ổn nhiều ngày trên môi trường thật.
- **Push.** 43 ca kiểm thử, nhưng là tính năng mới nhất và phụ thuộc dịch vụ Expo bên ngoài.
- **Ví Xu, gói tin, đánh giá người bán, tìm kiếm toàn văn.** Một phần hoặc khung rỗng.

## Điểm hai tài liệu nghiệp vụ đang cũ hơn mã nguồn

`LUAT-NGHIEP-VU.pdf` mục 19 và `DAC-TA-NGHIEP-VU-CHUAN.pdf` mục 10.3 ghi rằng từ chối mức "sai sót" vẫn làm tụt bậc uy tín. Mã nguồn hiện tại đã xét mức độ (audit mục 2.9, chốt 26/09/2026): từ chối mức sai sót không ghi gì vào uy tín, và có ca kiểm thử đo ở bậc 1 để phân biệt. Hai tài liệu đó cần cập nhật điểm này.

## Giới hạn

Lịch sử commit không dùng được để đo độ ổn định: chỉ có 16 commit từ đầu tháng 9, đặt tên tự do, không tách được commit sửa lỗi.
