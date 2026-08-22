import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import { TestUser, createTestApp, makeMaster, registerUser, startTestDb } from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let outsider: TestUser
let categoryId = ''

const asMaster = () => ({ Authorization: `Bearer ${master.token}` })

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)
  outsider = await registerUser(app, 'nguoi-la@template.local', 'Người lạ')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Master tạo danh mục kèm template', () => {
  it('một lượt gọi ra cả danh mục lẫn template đã phát hành', async () => {
    const res = await request(app)
      .post('/api/v1/categories')
      .set(asMaster())
      .send({
        name: 'Điện thoại',
        slug: 'dien-thoai',
        icon: '📱',
        template: {
          fields: [
            {
              key: 'brand',
              order: 10,
              required: true,
              filterable: true,
              define: {
                label: 'Hãng',
                type: 'select',
                options: [
                  { value: 'apple', label: 'Apple' },
                  { value: 'samsung', label: 'Samsung' },
                ],
              },
            },
            {
              key: 'batteryHealth',
              order: 20,
              define: { label: 'Độ chai pin', type: 'number', unit: '%' },
            },
          ],
        },
      })

    expect(res.status).toBe(201)
    categoryId = res.body.data.id

    const template = await request(app).get(`/api/v1/categories/${categoryId}/template`).expect(200)
    expect(template.body.data.version).toBe(1)
    expect(template.body.data.fields.map((f: { key: string }) => f.key)).toEqual([
      'brand',
      'batteryHealth',
    ])
    // `define` đã đi thẳng vào từ điển, không phải bản sao nằm riêng trong template.
    expect(template.body.data.fields[0].options).toHaveLength(2)
  })

  it('field vừa khai giờ nằm trong từ điển dùng chung', async () => {
    const res = await request(app).get('/api/v1/field-definitions').set(asMaster()).expect(200)

    const keys = res.body.data.map((d: { key: string }) => d.key)
    expect(keys).toContain('brand')
    expect(keys).toContain('batteryHealth')
  })

  it('danh mục thứ hai dùng lại `brand` mà không cần khai lại', async () => {
    const res = await request(app)
      .post('/api/v1/categories')
      .set(asMaster())
      .send({
        name: 'Xe cộ',
        slug: 'xe-co',
        template: { fields: [{ key: 'brand', order: 10, required: true }] },
      })

    expect(res.status).toBe(201)
  })

  it('key chưa có mà không khai `define` thì 400', async () => {
    const res = await request(app)
      .post('/api/v1/categories')
      .set(asMaster())
      .send({
        name: 'Đồ chơi',
        slug: 'do-choi',
        template: { fields: [{ key: 'khongTonTai', order: 10 }] },
      })

    expect(res.status).toBe(400)
  })

  it('danh mục không kèm template vẫn tạo được', async () => {
    const res = await request(app)
      .post('/api/v1/categories')
      .set(asMaster())
      .send({ name: 'Đồ dùng', slug: 'do-dung' })

    expect(res.status).toBe(201)
  })
})

describe('Vòng đời version', () => {
  it('sửa template đã phát hành phải qua bản nháp mới', async () => {
    const draft = await request(app)
      .post(`/api/v1/categories/${categoryId}/template`)
      .set(asMaster())
      .send({
        fields: [
          { key: 'brand', order: 10, required: true, filterable: true },
          { key: 'batteryHealth', order: 20 },
          { key: 'storage', order: 30, define: { label: 'Bộ nhớ', type: 'text' } },
        ],
      })

    expect(draft.status).toBe(201)
    expect(draft.body.data.version).toBe(2)

    // Chưa phát hành thì người đăng tin vẫn thấy v1.
    const serving = await request(app).get(`/api/v1/categories/${categoryId}/template`).expect(200)
    expect(serving.body.data.version).toBe(1)

    await request(app)
      .post(`/api/v1/categories/${categoryId}/template/2/publish`)
      .set(asMaster())
      .expect(200)

    const after = await request(app).get(`/api/v1/categories/${categoryId}/template`).expect(200)
    expect(after.body.data.version).toBe(2)
    expect(after.body.data.fields).toHaveLength(3)
  })

  it('bản v1 vẫn đọc được — tin cũ ghim nó', async () => {
    const res = await request(app)
      .get(`/api/v1/categories/${categoryId}/template?version=1`)
      .expect(200)

    expect(res.body.data.version).toBe(1)
    expect(res.body.data.fields).toHaveLength(2)
  })

  it('sửa bản ĐÃ phát hành thì bị chặn', async () => {
    const res = await request(app)
      .patch(`/api/v1/categories/${categoryId}/template/2`)
      .set(asMaster())
      .send({ fields: [{ key: 'brand', order: 10 }] })

    expect(res.status).toBe(400)
  })

  it('phát hành hai lần thì bị chặn', async () => {
    const res = await request(app)
      .post(`/api/v1/categories/${categoryId}/template/2/publish`)
      .set(asMaster())

    expect(res.status).toBe(400)
  })
})

describe('Chốt chặn hình dạng template', () => {
  const draft = (fields: unknown[]) =>
    request(app).post(`/api/v1/categories/${categoryId}/template`).set(asMaster()).send({ fields })

  it('hai field cùng order bị chặn', async () => {
    const res = await draft([
      { key: 'brand', order: 10 },
      { key: 'batteryHealth', order: 10 },
    ])
    expect(res.status).toBe(400)
  })

  it('`showIf` trỏ ra ngoài template bị chặn', async () => {
    const res = await draft([
      { key: 'brand', order: 10, showIf: { key: 'khongCoTrongForm', eq: 'x' } },
    ])
    expect(res.status).toBe(400)
  })

  it('quá 8 field mở lọc bị chặn', async () => {
    const fields = Array.from({ length: 9 }, (_, i) => ({
      key: `loc${i}`,
      order: (i + 1) * 10,
      filterable: true,
      define: { label: `Lọc ${i}`, type: 'text' },
    }))
    const res = await draft(fields)

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/mở lọc/)
  })

  it('key không phải camelCase bị chặn từ zod', async () => {
    const res = await draft([{ key: 'battery-health', order: 10 }])
    expect(res.status).toBe(400)
  })

  it('select mà không có options bị chặn', async () => {
    const res = await draft([
      { key: 'mauSac', order: 10, define: { label: 'Màu', type: 'select' } },
    ])
    expect(res.status).toBe(400)
  })

  it('cùng key mà khai kiểu khác với từ điển thì bị chặn', async () => {
    const res = await draft([
      { key: 'brand', order: 10, define: { label: 'Hãng', type: 'number' } },
    ])

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/hai kiểu/)
  })
})

describe('Chỉ master mới dựng được template', () => {
  it('người thường không tạo được bản nháp', async () => {
    const res = await request(app)
      .post(`/api/v1/categories/${categoryId}/template`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ fields: [{ key: 'brand', order: 10 }] })

    expect(res.status).toBe(403)
  })

  it('người thường không đọc được từ điển field', async () => {
    const res = await request(app)
      .get('/api/v1/field-definitions')
      .set('Authorization', `Bearer ${outsider.token}`)

    expect(res.status).toBe(403)
  })
})
