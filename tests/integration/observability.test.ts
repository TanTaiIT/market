import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { createTestApp, startTestDb } from '../helpers/fixtures'
import {
  currentRequestContext,
  runWithRequestContext,
  enrichRequestContext,
  sanitizeRequestId,
} from '../../src/common/observability/requestContext'

let app: Application
let mongod: MongoMemoryReplSet

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Health check', () => {
  it('DB sống thì 200 và báo db: up', async () => {
    const res = await request(app).get('/health').expect(200)
    expect(res.body).toMatchObject({ success: true, status: 'ok', db: 'up' })
  })

  /**
   * Ca quan trọng nhất của route này: DB chết thì health PHẢI đỏ. Bản trước trả `ok` vô điều
   * kiện, nghĩa là nơi deploy tiếp tục đẩy traffic vào một instance không phục vụ được gì.
   *
   * Ngắt đúng ở tầng mongoose rồi nối lại, thay vì dừng cả `mongod` — dừng server in-memory
   * làm mọi file test sau đó mất DB (fixtures dùng chung một instance cho cả lượt chạy).
   */
  it('DB chết thì 503 và báo db: down', async () => {
    const uri = mongod.getUri()
    await mongoose.disconnect()

    const res = await request(app).get('/health').expect(503)
    expect(res.body).toMatchObject({ success: false, status: 'degraded', db: 'down' })

    await mongoose.connect(uri)
    await request(app).get('/health').expect(200)
  }, 60_000)
})

describe('Request id', () => {
  it('mọi response mang X-Request-Id', async () => {
    const res = await request(app).get('/health').expect(200)
    expect(res.headers['x-request-id']).toMatch(/^[\w-]{8,}$/)
  })

  it('hai request nhận hai id khác nhau', async () => {
    const a = await request(app).get('/health').expect(200)
    const b = await request(app).get('/health').expect(200)
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id'])
  })

  /** Client/proxy gửi id lên thì giữ nguyên — đó là cách nối dấu vết qua nhiều tầng dịch vụ. */
  it('giữ nguyên id do client gửi lên', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'rn-app-abc123').expect(200)
    expect(res.headers['x-request-id']).toBe('rn-app-abc123')
  })

  /**
   * Id là thứ đi thẳng vào log, mà log là nơi con người đọc và nơi hệ thu log tách field. Nhận
   * bừa chuỗi của client là mở đường tiêm rác vào chính công cụ điều tra sự cố.
   */
  it('id rác của client bị bỏ, sinh id mới thay vì trả 400', async () => {
    // Chỉ thử chuỗi QUÁ DÀI ở tầng HTTP: ký tự điều khiển bị chính client Node từ chối trước
    // khi ra khỏi máy, nên ca đó chỉ kiểm được ở tầng hàm — xem ca `sanitize` bên dưới.
    const junk = 'x'.repeat(500)
    const res = await request(app).get('/health').set('X-Request-Id', junk).expect(200)
    expect(res.headers['x-request-id']).not.toBe(junk)
    expect(res.headers['x-request-id']).toMatch(/^[\w-]{8,}$/)
  })
})

describe('Ngữ cảnh chẩn đoán', () => {
  it('sanitize: nhận id an toàn, thay id xấu', () => {
    expect(sanitizeRequestId('abc-123_x.y:z')).toBe('abc-123_x.y:z')
    expect(sanitizeRequestId('short')).not.toBe('short')
    expect(sanitizeRequestId('has space here')).not.toBe('has space here')
    expect(sanitizeRequestId('abc\n injected')).not.toContain('\n')
    expect(sanitizeRequestId('x'.repeat(500)).length).toBeLessThanOrEqual(64)
    expect(sanitizeRequestId(undefined)).toMatch(/^[\w-]{8,}$/)
  })

  it('không có ngữ cảnh thì trả undefined, không ném', () => {
    expect(currentRequestContext()).toBeUndefined()
    // Job nền gọi `enrich` ngoài mọi request — phải im lặng bỏ qua, không làm sập job.
    expect(() => enrichRequestContext({ userId: 'u1' })).not.toThrow()
  })

  /**
   * `enrich` sửa TẠI CHỖ chứ không mở ngữ cảnh con: danh tính chỉ biết được ở giữa chuỗi
   * middleware, mà mở ngữ cảnh con ở đó thì `res.on('finish')` của access log — chạy song song
   * bên ngoài — vẫn thấy ngữ cảnh cũ và log ra một request không có ai.
   */
  it('enrich thấy được từ nhánh async chạy song song', async () => {
    await runWithRequestContext({ requestId: 'test-req-id' }, async () => {
      const seenLater = new Promise<string | undefined>((resolve) => {
        setTimeout(() => resolve(currentRequestContext()?.userId), 5)
      })
      enrichRequestContext({ userId: 'user-42', orgSlug: 'truong-a' })

      expect(await seenLater).toBe('user-42')
      expect(currentRequestContext()).toEqual({
        requestId: 'test-req-id',
        userId: 'user-42',
        orgSlug: 'truong-a',
      })
    })
  })
})
