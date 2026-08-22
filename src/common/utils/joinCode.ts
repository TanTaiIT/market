import { randomInt } from 'node:crypto'

/**
 * Mã nhóm — thứ người dùng gõ tay hoặc dán vào ô "tìm nhóm" để xin tham gia.
 *
 * Thay cho slug vì hai thứ có mục đích khác nhau: slug là địa chỉ CÔNG KHAI, đoán được và nằm
 * trong mọi đường dẫn; mã nhóm là thứ chỉ ai được đưa mới có, và **đổi được** khi rò rỉ. Dùng
 * slug để gia nhập nghĩa là bất kỳ ai nhìn thấy tên tổ chức cũng gõ được đơn xin vào.
 */

/**
 * Bảng chữ cái bỏ mọi ký tự nhìn giống nhau: `0/O`, `1/I/L`.
 *
 * Mã này được ĐỌC QUA ĐIỆN THOẠI và chép tay, nên một ký tự nhập nhằng không phải bất tiện nhỏ
 * mà là một lượt "tôi gõ đúng rồi mà nó báo sai". 31 ký tự × 6 vị trí ≈ 887 triệu tổ hợp.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const JOIN_CODE_LENGTH = 6

/** `randomInt` của `node:crypto` chứ không phải `Math.random`: mã đoán được là mã vô dụng. */
export function generateJoinCode(): string {
  let code = ''
  for (let i = 0; i < JOIN_CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)]
  return code
}

/**
 * Chuẩn hoá thứ người dùng gõ vào: bỏ khoảng trắng, gạch nối và viết hoa.
 *
 * Người ta chép mã từ tin nhắn thành `abc-123` hoặc ` ABC 123 `. Bắt họ gõ lại cho đúng định
 * dạng là một rào cản không đổi lấy được gì — mã vẫn duy nhất sau khi chuẩn hoá.
 */
export function normalizeJoinCode(input: string): string {
  return input.replaceAll(/[\s-]/g, '').toUpperCase()
}
