# Bộ tài liệu thiết kế lại sàn rao vặt

Thư mục này gom mọi tài liệu, lược đồ và mã nguồn dựng tài liệu được tạo trong đợt rà soát và thiết kế lại, từ 06/10/2026.

## Đọc theo thứ tự

| # | File | Nội dung |
|---|---|---|
| 1 | `DANH-GIA-DO-ON-DINH.md` | Hệ đang chạy ổn ở đâu: kết quả 1.293 ca kiểm thử, audit 26/09, cụm ổn và chưa ổn |
| 2 | `pdf/DAC-TA-CUM-TINH-NANG.pdf` | 12 cụm tính năng của hệ đang chạy: khả năng, luật, con số, API (13 trang) |
| 3 | `pdf/RA-SOAT-DAC-TA-NGHIEP-VU.pdf` | 23 lỗ hổng của bản đặc tả đích `DAC-TA-NGHIEP-VU-CHUAN.pdf` (8 trang) |
| 4 | `pdf/THIET-KE-HE-THONG-MOI.pdf` | **Bản v3, 08/10/2026.** Thiết kế hệ mới theo ba quyết định chốt: master toàn quyền; máy duyệt tin, đạt chuẩn thì lên ngay, máy không chắc thì giữ cho người quản lý tin duyệt và quá hạn vẫn giữ; chỉ xác thực email, số điện thoại hoãn. 31 trang, 19 lược đồ. Mục 26 trả lời 30 mục rà soát bản v1, mục 27 trả lời 23 mục rà soát bản v2 |
| 5 | `pdf/THIET-KE-HE-THONG-MOI.v2.pdf` | Bản v2, 07/10/2026, giữ để đối chiếu. Khác v3 ở chỗ máy còn tự từ chối tin dải Cao, mọi đường quá hạn đều tự mở, mức T1 cần số điện thoại |
| 6 | `pdf/THIET-KE-HE-THONG-MOI.v1.pdf` | Bản v1, 06/10/2026, giữ để đối chiếu. Còn người duyệt trước khi đăng và master bị ràng buộc như staff |

Hai tài liệu gốc của dự án, `LUAT-NGHIEP-VU.pdf` và `DAC-TA-NGHIEP-VU-CHUAN.pdf`, vẫn ở thư mục `docs/` cha và không bị sửa.

## Hình ảnh

- `hinh-anh/so-do/` có 19 lược đồ của bản thiết kế v3, mỗi lược đồ một file PNG và một file SVG. Số đầu tên file là số mục trong PDF.
- `hinh-anh/trang/` có ảnh từng trang của bản thiết kế v3, `trang-01.png` tới `trang-31.png`.

File SVG vẽ chữ bằng `foreignObject`, nên mở đúng trong trình duyệt và trong tài liệu web. Một số phần mềm đồ hoạ không hiển thị được phần chữ đó; khi ấy dùng file PNG.

## Dựng lại sau khi sửa

Mã nguồn nằm trong `nguon/`. Mỗi PDF dựng từ đúng một file HTML cùng tên.

```bash
cd nguon
npm install
npm run build
```

- Cần Chrome đã cài trên máy. Nếu Chrome không ở `C:/Program Files/Google/Chrome/Application/chrome.exe` thì đặt biến môi trường `CHROME_PATH`.
- `npm run build` ghi đè ba PDF chính trong `pdf/` và dựng lại toàn bộ `hinh-anh/so-do/` và `hinh-anh/trang/`. Đừng để file tay vào hai thư mục ảnh đó. Các bản `.v1.pdf`, `.v2.pdf` không bị đụng.
- Muốn dựng riêng một tài liệu: `npm run build:thiet-ke`, `npm run build:ra-soat`, hoặc `npm run build:cum-tinh-nang`.
- PDF đang mở trong trình xem hay IDE bị khoá trên Windows; đóng file trước khi dựng, nếu không bước ghi PDF sẽ lỗi.

### Riêng bản thiết kế

`thiet-ke-he-thong-moi.html` là file **lắp ráp**, không sửa trực tiếp. Nó được dựng theo lớp: bắt đầu từ `thiet-ke-he-thong-moi.v1.html`, đè các mục trong `nguon/v2/`, rồi đè tiếp các mục trong `nguon/v3/`. Mỗi mục là một file `<khoá mục>.html` (bìa là `COVER.html`); mục nào không có file ở lớp trên thì lấy từ lớp dưới. Sửa bản hiện hành thì sửa trong `nguon/v3/`; `v2/` và file v1 chỉ còn để đối chiếu. Sửa xong chạy:

```bash
node apply.mjs         # lắp ráp lại thiet-ke-he-thong-moi.html (v1 ← v2 ← v3)
npm run build:thiet-ke # lắp ráp rồi dựng PDF và ảnh
```

Khoá mục là chữ sau dấu `=` trong dòng chú thích đầu file, ví dụ `<!-- ===== 12 HUMAN QUEUES -->` có khoá `12`. Một mục dài hai trang dùng hai khoá, trang sau thêm chữ `B` (`26` và `26B`, `27` và `27B`); khoá mới chưa có ở lớp dưới thì được nối vào cuối tài liệu. Thêm mục mới thì nhớ thêm dòng vào mục lục trong `COVER.html`.

Lược đồ viết bằng Mermaid, đặt ngay trong từng file mục dưới dạng khối `<script type="text/x-mermaid">`. Màu và cỡ chữ chung nằm ở `mermaid-config.json`. Mermaid 12 bỏ qua `rankSpacing` và `nodeSpacing`; muốn lược đồ gọn hơn thì gộp nút hoặc rút ngắn nhãn, không chỉnh được khoảng cách. `render.mjs` in ra bảng tỉ lệ từng lược đồ (`SMALL` khi phải thu dưới 0,62) và chiều cao từng trang (`OVERFLOW` khi quá 188 mm) để biết chỗ cần gọn lại.

`node_modules/` sinh ra sau `npm install` đã được `.gitignore` của dự án bỏ qua.
