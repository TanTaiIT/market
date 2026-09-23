import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { signUploadParams } from '../../src/features/upload/upload.service'

/**
 * Thuật toán chữ ký Cloudinary — thứ đáng test nhất của cả module upload.
 *
 * Sai một chi tiết (quên sắp khoá, nối bằng `,` thay vì `&`, chèn thêm dấu phân cách trước
 * `api_secret`) thì Cloudinary chỉ trả **401 Invalid Signature**, không nói sai ở đâu. Không có
 * test này thì cách duy nhất để dò là thử-và-sai trên một tài khoản thật.
 */
describe('signUploadParams', () => {
  const secret = 'abcd1234secret'

  it('sắp khoá theo alphabet rồi nối bằng &, api_secret dán liền vào đuôi', () => {
    // Cố tình truyền SAI thứ tự để bắt được lỗi quên `.sort()` — object literal giữ nguyên thứ tự
    // khai báo, nên nếu bỏ sort thì chuỗi ra `upload_preset=...&folder=...` và test này đỏ.
    const actual = signUploadParams(
      { upload_preset: 'ghim_unsigned', folder: 'ghim', timestamp: 1_700_000_000 },
      secret,
    )

    const expected = createHash('sha1')
      .update('folder=ghim&timestamp=1700000000&upload_preset=ghim_unsigned' + secret)
      .digest('hex')

    expect(actual).toBe(expected)
  })

  it('cùng tham số cùng secret → cùng chữ ký', () => {
    const params = { folder: 'ghim', timestamp: 1_700_000_000, upload_preset: 'p' }
    expect(signUploadParams(params, secret)).toBe(signUploadParams({ ...params }, secret))
  })

  it('đổi MỘT tham số là đổi chữ ký — không có trường nào bị bỏ quên khi ký', () => {
    const base = { folder: 'ghim', timestamp: 1_700_000_000, upload_preset: 'p' }
    const signed = signUploadParams(base, secret)

    expect(signUploadParams({ ...base, folder: 'khac' }, secret)).not.toBe(signed)
    expect(signUploadParams({ ...base, timestamp: 1_700_000_001 }, secret)).not.toBe(signed)
    expect(signUploadParams({ ...base, upload_preset: 'khac' }, secret)).not.toBe(signed)
    expect(signUploadParams(base, 'secret-khac')).not.toBe(signed)
  })

  it('trả hex SHA-1 — 40 ký tự, đúng dạng Cloudinary nhận', () => {
    expect(signUploadParams({ timestamp: 1 }, secret)).toMatch(/^[0-9a-f]{40}$/)
  })
})
