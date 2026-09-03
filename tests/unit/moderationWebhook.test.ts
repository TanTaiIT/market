import { createHash } from 'crypto'
import { describe, it, expect } from 'vitest'
import {
  cloudinaryModerationEventSchema,
  rejectedImagePattern,
  verifyCloudinarySignature,
} from '../../src/features/moderation/moderation.webhook'

const CLOUD = 'ds4dqc7s5'
const SECRET = 'test-secret'

function sign(body: string, timestamp: string, algo: 'sha1' | 'sha256' = 'sha1'): string {
  return createHash(algo)
    .update(body + timestamp + SECRET)
    .digest('hex')
}

describe('Webhook kiểm duyệt ảnh — chữ ký', () => {
  const body = '{"notification_type":"moderation"}'
  const ts = '1724300000'

  it('chữ ký SHA-1 đúng thì qua', () => {
    expect(verifyCloudinarySignature(body, ts, sign(body, ts), SECRET)).toBe(true)
  })

  it('tài khoản bật SHA-256 cũng qua, không cần cấu hình thêm', () => {
    expect(verifyCloudinarySignature(body, ts, sign(body, ts, 'sha256'), SECRET)).toBe(true)
  })

  it('sai secret, sai timestamp, hay body bị sửa — đều rớt', () => {
    expect(verifyCloudinarySignature(body, ts, sign(body, '9999999999'), SECRET)).toBe(false)
    expect(verifyCloudinarySignature('{"khác":1}', ts, sign(body, ts), SECRET)).toBe(false)
    expect(verifyCloudinarySignature(body, ts, 'không-phải-hex', SECRET)).toBe(false)
    expect(verifyCloudinarySignature(body, ts, '', SECRET)).toBe(false)
  })

  it('nhận Buffer y như string — controller đưa rawBody là Buffer', () => {
    expect(verifyCloudinarySignature(Buffer.from(body), ts, sign(body, ts), SECRET)).toBe(true)
  })
})

describe('Webhook kiểm duyệt ảnh — khớp URL trong DB', () => {
  const pattern = rejectedImagePattern('ghim/abc123', CLOUD)

  it('khớp secure_url chuẩn (có version) và bản không version', () => {
    expect(
      pattern.test(`https://res.cloudinary.com/${CLOUD}/image/upload/v17243/ghim/abc123.jpg`),
    ).toBe(true)
    expect(pattern.test(`https://res.cloudinary.com/${CLOUD}/image/upload/ghim/abc123.webp`)).toBe(
      true,
    )
  })

  it('không khớp public_id khác, cloud khác, hay id chỉ trùng đuôi', () => {
    expect(
      pattern.test(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/ghim/abc124.jpg`),
    ).toBe(false)
    expect(
      pattern.test('https://res.cloudinary.com/cloud-khac/image/upload/v1/ghim/abc123.jpg'),
    ).toBe(false)
    // "xabc123" chứa "abc123" — regex phải neo theo ranh giới path, không phải substring.
    expect(
      pattern.test(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/ghim/xabc123.jpg`),
    ).toBe(false)
  })

  it('ký tự đặc biệt trong public_id không phá regex', () => {
    const dotted = rejectedImagePattern('ghim/a.b+c', CLOUD)
    expect(dotted.test(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/ghim/a.b+c.jpg`)).toBe(
      true,
    )
    expect(dotted.test(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/ghim/aXb+c.jpg`)).toBe(
      false,
    )
  })
})

describe('Webhook kiểm duyệt ảnh — đọc payload', () => {
  it('payload moderation chuẩn đọc được, field lạ bị bỏ qua chứ không chặn', () => {
    const parsed = cloudinaryModerationEventSchema.safeParse({
      notification_type: 'moderation',
      moderation_status: 'rejected',
      moderation_kind: 'aws_rek',
      public_id: 'ghim/abc123',
      asset_id: 'field-lạ-cloudinary-mới-thêm',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.moderation_status).toBe('rejected')
  })

  it('thiếu notification_type là payload không đọc được', () => {
    expect(cloudinaryModerationEventSchema.safeParse({ public_id: 'x' }).success).toBe(false)
  })
})
