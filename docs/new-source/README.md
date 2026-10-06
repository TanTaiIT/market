# Bộ tài liệu thiết kế lại sàn rao vặt

Thư mục này gom mọi tài liệu, lược đồ và mã nguồn dựng tài liệu được tạo trong đợt rà soát và thiết kế lại, từ 06/10/2026.

## Đọc theo thứ tự

| # | File | Nội dung |
|---|---|---|
| 1 | `DANH-GIA-DO-ON-DINH.md` | Hệ đang chạy ổn ở đâu: kết quả 1.293 ca kiểm thử, audit 26/09, cụm ổn và chưa ổn |
| 2 | `pdf/DAC-TA-CUM-TINH-NANG.pdf` | 12 cụm tính năng của hệ đang chạy: khả năng, luật, con số, API (13 trang) |
| 3 | `pdf/RA-SOAT-DAC-TA-NGHIEP-VU.pdf` | 23 lỗ hổng của bản đặc tả đích `DAC-TA-NGHIEP-VU-CHUAN.pdf` (8 trang) |
| 4 | `pdf/THIET-KE-HE-THONG-MOI.pdf` | Thiết kế hệ mới: một trục nhóm, staff theo danh mục, uy tín mới, duyệt máy mới, quản lý tin; 20 lược đồ (27 trang) |

Hai tài liệu gốc của dự án, `LUAT-NGHIEP-VU.pdf` và `DAC-TA-NGHIEP-VU-CHUAN.pdf`, vẫn ở thư mục `docs/` cha và không bị sửa.

## Hình ảnh

- `hinh-anh/so-do/` có 19 lược đồ của bản thiết kế, mỗi lược đồ một file PNG và một file SVG. Số đầu tên file là số mục trong PDF.
- `hinh-anh/trang/` có ảnh từng trang của bản thiết kế, `trang-01.png` tới `trang-27.png`.

File SVG vẽ chữ bằng `foreignObject`, nên mở đúng trong trình duyệt và trong tài liệu web. Một số phần mềm đồ hoạ không hiển thị được phần chữ đó; khi ấy dùng file PNG.

## Dựng lại sau khi sửa

Mã nguồn nằm trong `nguon/`. Mỗi PDF dựng từ đúng một file HTML cùng tên.

```bash
cd nguon
npm install
npm run build
```

- Cần Chrome đã cài trên máy. Nếu Chrome không ở `C:/Program Files/Google/Chrome/Application/chrome.exe` thì đặt biến môi trường `CHROME_PATH`.
- `npm run build` ghi đè ba PDF trong `pdf/` và dựng lại toàn bộ `hinh-anh/so-do/` và `hinh-anh/trang/`. Đừng để file tay vào hai thư mục ảnh đó.
- Muốn dựng riêng một tài liệu: `npm run build:thiet-ke`, `npm run build:ra-soat`, hoặc `npm run build:cum-tinh-nang`.
- Lược đồ viết bằng Mermaid, đặt ngay trong `thiet-ke-he-thong-moi.html` dưới dạng khối `<script type="text/x-mermaid">`. Màu và cỡ chữ chung nằm ở `mermaid-config.json`.
- `node_modules/` sinh ra sau `npm install` đã được `.gitignore` của dự án bỏ qua.
