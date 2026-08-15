/**
 * Danh sách đơn vị hành chính cấp tỉnh sau sáp nhập 01/07/2025 (Nghị quyết 202/2025/QH15):
 * 34 đơn vị = 6 thành phố trực thuộc trung ương + 28 tỉnh.
 *
 * Đây là danh sách ĐÓNG, cố tình không cho nhập tự do: `location.province` được lọc bằng
 * so khớp chuỗi chính xác (`buildFilter`), nên chỉ cần lệch một dấu hoặc một tiền tố là
 * bộ lọc trả về rỗng mà không có lỗi nào — hỏng im lặng, không ai phát hiện ra.
 *
 * `name` là giá trị lưu xuống DB và đi trên query string; `fullName` chỉ để hiển thị khi
 * cần đúng văn bản hành chính. Đổi `name` = phá dữ liệu cũ, phải kèm migration.
 *
 * `formerNames` là tỉnh cũ đã nhập vào đơn vị này. App dùng nó cho ô tìm kiếm (gõ "Bình Dương"
 * phải ra "Hồ Chí Minh") và để chú thích dưới mỗi dòng — nên nó là dữ liệu, không phải chú thích.
 *
 * `aliases` là cách gọi tắt và tên thành phố quen thuộc, CHỈ để dò tìm. Tách khỏi `formerNames`
 * vì app hiển thị `formerNames` dưới dạng "gồm ..." — hiện "gồm Sài Gòn" thì thành sai sự thật
 * hành chính, Sài Gòn chưa bao giờ là một tỉnh bị nhập vào TP.HCM.
 */
const PROVINCE_TABLE = [
  { name: 'Hà Nội', fullName: 'Thành phố Hà Nội', formerNames: [], aliases: ['HN', 'Hà Tây'] },
  { name: 'Cao Bằng', fullName: 'Tỉnh Cao Bằng', formerNames: [], aliases: [] },
  { name: 'Tuyên Quang', fullName: 'Tỉnh Tuyên Quang', formerNames: ['Hà Giang'], aliases: [] },
  { name: 'Lào Cai', fullName: 'Tỉnh Lào Cai', formerNames: ['Yên Bái'], aliases: [] },
  { name: 'Điện Biên', fullName: 'Tỉnh Điện Biên', formerNames: [], aliases: [] },
  { name: 'Lai Châu', fullName: 'Tỉnh Lai Châu', formerNames: [], aliases: [] },
  { name: 'Sơn La', fullName: 'Tỉnh Sơn La', formerNames: [], aliases: [] },
  { name: 'Thái Nguyên', fullName: 'Tỉnh Thái Nguyên', formerNames: ['Bắc Kạn'], aliases: [] },
  { name: 'Lạng Sơn', fullName: 'Tỉnh Lạng Sơn', formerNames: [], aliases: [] },
  { name: 'Quảng Ninh', fullName: 'Tỉnh Quảng Ninh', formerNames: [], aliases: ['Hạ Long'] },
  { name: 'Bắc Ninh', fullName: 'Tỉnh Bắc Ninh', formerNames: ['Bắc Giang'], aliases: [] },
  {
    name: 'Phú Thọ',
    fullName: 'Tỉnh Phú Thọ',
    formerNames: ['Vĩnh Phúc', 'Hòa Bình'],
    aliases: ['Việt Trì'],
  },
  {
    name: 'Hải Phòng',
    fullName: 'Thành phố Hải Phòng',
    formerNames: ['Hải Dương'],
    aliases: ['HP'],
  },
  { name: 'Hưng Yên', fullName: 'Tỉnh Hưng Yên', formerNames: ['Thái Bình'], aliases: [] },
  {
    name: 'Ninh Bình',
    fullName: 'Tỉnh Ninh Bình',
    formerNames: ['Hà Nam', 'Nam Định'],
    aliases: [],
  },
  { name: 'Thanh Hóa', fullName: 'Tỉnh Thanh Hóa', formerNames: [], aliases: [] },
  { name: 'Nghệ An', fullName: 'Tỉnh Nghệ An', formerNames: [], aliases: ['Vinh'] },
  { name: 'Hà Tĩnh', fullName: 'Tỉnh Hà Tĩnh', formerNames: [], aliases: [] },
  {
    name: 'Quảng Trị',
    fullName: 'Tỉnh Quảng Trị',
    formerNames: ['Quảng Bình'],
    aliases: ['Đông Hà'],
  },
  { name: 'Huế', fullName: 'Thành phố Huế', formerNames: ['Thừa Thiên Huế'], aliases: [] },
  {
    name: 'Đà Nẵng',
    fullName: 'Thành phố Đà Nẵng',
    formerNames: ['Quảng Nam'],
    aliases: ['ĐN', 'Hội An'],
  },
  { name: 'Quảng Ngãi', fullName: 'Tỉnh Quảng Ngãi', formerNames: ['Kon Tum'], aliases: [] },
  {
    name: 'Gia Lai',
    fullName: 'Tỉnh Gia Lai',
    formerNames: ['Bình Định'],
    aliases: ['Quy Nhơn', 'Pleiku'],
  },
  {
    name: 'Đắk Lắk',
    fullName: 'Tỉnh Đắk Lắk',
    formerNames: ['Phú Yên'],
    aliases: ['Buôn Ma Thuột', 'Tuy Hòa'],
  },
  {
    name: 'Khánh Hòa',
    fullName: 'Tỉnh Khánh Hòa',
    formerNames: ['Ninh Thuận'],
    aliases: ['Nha Trang'],
  },
  {
    name: 'Lâm Đồng',
    fullName: 'Tỉnh Lâm Đồng',
    formerNames: ['Đắk Nông', 'Bình Thuận'],
    aliases: ['Đà Lạt', 'Phan Thiết'],
  },
  {
    name: 'Đồng Nai',
    fullName: 'Tỉnh Đồng Nai',
    formerNames: ['Bình Phước'],
    aliases: ['Biên Hòa'],
  },
  { name: 'Tây Ninh', fullName: 'Tỉnh Tây Ninh', formerNames: ['Long An'], aliases: [] },
  {
    name: 'Hồ Chí Minh',
    fullName: 'Thành phố Hồ Chí Minh',
    formerNames: ['Bình Dương', 'Bà Rịa - Vũng Tàu'],
    aliases: ['Sài Gòn', 'TPHCM', 'HCM', 'Vũng Tàu', 'Thủ Dầu Một'],
  },
  {
    name: 'Đồng Tháp',
    fullName: 'Tỉnh Đồng Tháp',
    formerNames: ['Tiền Giang'],
    aliases: ['Mỹ Tho', 'Cao Lãnh'],
  },
  {
    name: 'Vĩnh Long',
    fullName: 'Tỉnh Vĩnh Long',
    formerNames: ['Bến Tre', 'Trà Vinh'],
    aliases: [],
  },
  {
    name: 'An Giang',
    fullName: 'Tỉnh An Giang',
    formerNames: ['Kiên Giang'],
    aliases: ['Phú Quốc', 'Rạch Giá', 'Long Xuyên'],
  },
  {
    name: 'Cần Thơ',
    fullName: 'Thành phố Cần Thơ',
    formerNames: ['Sóc Trăng', 'Hậu Giang'],
    aliases: [],
  },
  { name: 'Cà Mau', fullName: 'Tỉnh Cà Mau', formerNames: ['Bạc Liêu'], aliases: [] },
] as const

export const VN_PROVINCES = PROVINCE_TABLE
export type VnProvinceName = (typeof PROVINCE_TABLE)[number]['name']

// z.enum đòi tuple không rỗng; `.map` chỉ cho ra mảng nên phải ép lại kiểu — giữ một
// bảng nguồn duy nhất vẫn đáng hơn là chép tay danh sách tên ra lần thứ hai.
export const VN_PROVINCE_NAMES = PROVINCE_TABLE.map((p) => p.name) as [
  VnProvinceName,
  ...VnProvinceName[],
]
