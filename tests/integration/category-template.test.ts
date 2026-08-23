import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'

let app: Application
let mongod: MongoMemoryReplSet

let masterToken: string
let orgHeaders: Record<string, string>
/** Danh mục CÓ template riêng (Điện thoại) và danh mục chỉ có bản chung. */
let phoneCategoryId: string
let otherCategoryId: string

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  const uri = mongod.getUri()
  process.env.MONGO_URI = uri
  process.env.JWT_SECRET = 'test_secret'
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret'
  delete process.env.APP_BASE_DOMAIN

  await mongoose.connect(uri)

  const { createApp } = await import('../../src/app')
  app = createApp()

  const { makeMaster, registerUser, createOrg, orgAuth, setTrustLevel } =
    await import('../helpers/fixtures')

  masterToken = (await makeMaster(app, 'master@platform.local')).token

  // Chạy CHÍNH script seed, không dựng fixture riêng: nếu `seedCatalog` và code lệch nhau thì
  // đây là chỗ duy nhất phát hiện được trước khi lên production.
  const { upsertCatalog } = await import('../../scripts/seedCatalog')
  const idBySlug = await upsertCatalog()
  phoneCategoryId = idBySlug.get('dien-thoai')!
  otherCategoryId = idBySlug.get('khac')!

  const owner = await registerUser(app, 'owner@tpl-org.local', 'Tpl Owner')
  const org = await createOrg(app, masterToken, {
    name: 'Tpl Org',
    slug: 'tpl-org',
    ownerEmail: owner.email,
  })
  orgHeaders = orgAuth(owner.token, org.slug)
  await setTrustLevel(owner.id, 1)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const getTemplate = (categoryId: string) =>
  request(app).get(`/api/v1/categories/${categoryId}/template`)

const listingBody = (categoryId: string, attributes?: Record<string, unknown>) => ({
  title: 'iPhone 13 Pro Max còn bảo hành',
  description: 'Máy đẹp, dùng giữ gìn, đủ phụ kiện.',
  price: 12_000_000,
  categoryId,
  images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
  ...(attributes ? { attributes } : {}),
})

describe('GET /categories/:id/template', () => {
  it('trả template riêng đã ghép sẵn label + options', async () => {
    const res = await getTemplate(phoneCategoryId).expect(200)
    const { isFallback, fields } = res.body.data

    expect(isFallback).toBe(false)

    // Đã ghép với từ điển: FE không phải gọi vòng hai để tra `label`.
    const brand = fields.find((f: { key: string }) => f.key === 'brand')
    expect(brand.label).toBe('Hãng')
    // `override` của template thắng từ điển — `brand` ở Điện thoại là dropdown, không phải ô nhập.
    expect(brand.type).toBe('select')
    expect(brand.options.map((o: { value: string }) => o.value)).toContain('apple')
  })

  it('field trả về đã sắp theo order', async () => {
    const res = await getTemplate(phoneCategoryId).expect(200)
    const orders = res.body.data.fields.map((f: { order: number }) => f.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('danh mục chưa có template riêng rơi về bản chung', async () => {
    const res = await getTemplate(otherCategoryId).expect(200)
    expect(res.body.data.isFallback).toBe(true)
    // Bản chung: 4 field, không cái nào bắt buộc.
    expect(res.body.data.fields.map((f: { key: string }) => f.key)).toEqual([
      'brand',
      'quantity',
      'origin',
      'warranty',
    ])
    expect(res.body.data.fields.every((f: { required: boolean }) => !f.required)).toBe(true)
  })

  it('?version= ghim đúng bản đó — form sửa tin dựng lại bộ field lúc tạo tin', async () => {
    const { CategoryTemplate } =
      await import('../../src/features/category-template/category-template.model')
    // v2 bỏ `repairHistory` và thêm `ram` — đủ khác để phân biệt hai bản.
    const v2 = await CategoryTemplate.create({
      categoryId: phoneCategoryId,
      version: 2,
      status: 'published',
      fieldKeys: [
        { key: 'brand', order: 10, required: true },
        { key: 'ram', order: 20, required: true },
      ],
    })

    // `finally` chứ không dọn ở cuối thân test: v2 là bản MỚI NHẤT khi nó còn tồn tại, nên để
    // sót lại là mọi test đăng tin phía sau bị xét bằng một template khác hẳn.
    try {
      const latest = await getTemplate(phoneCategoryId).expect(200)
      expect(latest.body.data.version).toBe(2)
      expect(latest.body.data.fields.map((f: { key: string }) => f.key)).toContain('ram')

      const pinned = await getTemplate(phoneCategoryId).query({ version: 1 }).expect(200)
      expect(pinned.body.data.version).toBe(1)
      expect(pinned.body.data.fields.map((f: { key: string }) => f.key)).toContain('repairHistory')
    } finally {
      await CategoryTemplate.deleteOne({ _id: v2._id })
    }
  })

  it('version không tồn tại rơi về bản mới nhất, không 404', async () => {
    // Sửa tin bằng một form hơi lệch vẫn tốt hơn là không sửa được.
    const res = await getTemplate(phoneCategoryId).query({ version: 99 }).expect(200)
    expect(res.body.data.version).toBeGreaterThan(0)
  })
})

describe('POST /listings — attributes đi qua template', () => {
  it('ép kiểu rồi mới lưu: chuỗi "87" thành số 87', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      .send(
        listingBody(phoneCategoryId, {
          brand: 'apple',
          model: 'iPhone 13 Pro Max',
          storage: '256',
          repairHistory: 'original',
          batteryHealth: '87',
        }),
      )
      .expect(201)

    expect(res.body.data.attributes.batteryHealth).toBe(87)
    expect(res.body.data.templateRef.isFallback).toBe(false)
  })

  it('thiếu field bắt buộc của template là 400', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      // thiếu `repairHistory`, thứ template Điện thoại để required có chủ ý
      .send(listingBody(phoneCategoryId, { brand: 'apple', model: 'X', storage: '256' }))
      .expect(400)

    expect(res.body.message).toContain('Lịch sử sửa chữa')
  })

  it('option không có trong danh sách là 400, không lặng lẽ lưu', async () => {
    await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      .send(
        listingBody(phoneCategoryId, {
          brand: 'nokia3310',
          model: 'X',
          storage: '256',
          repairHistory: 'original',
        }),
      )
      .expect(400)
  })

  it('key không có trong template bị loại, không lọt vào DB', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      .send(
        listingBody(phoneCategoryId, {
          brand: 'apple',
          model: 'X',
          storage: '256',
          repairHistory: 'original',
          bandwidth: 'bịa ra',
        }),
      )
      .expect(201)

    expect(res.body.data.attributes.bandwidth).toBeUndefined()
  })

  it('chỉ field filterable mới vào attrs — đây là thứ giữ index không phình', async () => {
    const res = await request(app)
      .post('/api/v1/listings')
      .set(orgHeaders)
      .send(
        listingBody(phoneCategoryId, {
          brand: 'apple',
          model: 'iPhone 12',
          storage: '128',
          repairHistory: 'screen',
          color: 'xanh',
        }),
      )
      .expect(201)

    // Đọc từ DB: `attrs` cố tình KHÔNG có trong response (`toJSON` xoá nó) vì nó chỉ phục vụ
    // index. Khẳng định luôn cả điều đó ở dòng dưới.
    expect(res.body.data.attrs).toBeUndefined()

    const { Listing } = await import('../../src/features/listing/listing.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    // `Listing` có tenantPlugin — đọc ngoài request không có scope, phải khai tường minh
    // (AGENT §12d), y như `activateListing` trong `tests/helpers/fixtures.ts`.
    const saved = await runUnscoped('test đọc attrs', () =>
      Listing.findById(res.body.data._id).exec(),
    )
    const keys = (saved!.attrs as { k: string }[]).map((a) => a.k)
    expect(keys).toContain('brand')
    // `color` và `model` không filterable trong template Điện thoại.
    expect(keys).not.toContain('color')
    expect(keys).not.toContain('model')
  })
})

const attrs = (o: Record<string, unknown>) => encodeURIComponent(JSON.stringify(o))

/**
 * Lọc theo thuộc tính động (`?attrs=`).
 *
 * Hai chốt chặn là phần đáng test nhất ở đây: thiếu chúng thì client lọc được bằng key bất kỳ,
 * vừa quét toàn bảng vừa thành đường dò xem dữ liệu có thuộc tính nào.
 */
describe('GET /listings?attrs=', () => {
  beforeAll(async () => {
    const { publishListing } = await import('../helpers/fixtures')

    for (const [brand, storage] of [
      ['apple', '256'],
      ['samsung', '128'],
    ] as const) {
      const res = await request(app)
        .post('/api/v1/listings')
        .set(orgHeaders)
        .send({
          ...listingBody(phoneCategoryId, {
            brand,
            storage,
            repairHistory: 'original',
            model: 'Test model',
          }),
          title: `Máy hãng ${brand} bộ nhớ ${storage}`,
          visibility: 'public',
          provinceCode: 'Hồ Chí Minh',
        })
        .expect(201)
      await publishListing(res.body.data._id)
    }
  }, 60_000)

  it('lọc đúng theo một thuộc tính', async () => {
    const res = await request(app)
      .get(`/api/v1/listings?category=${phoneCategoryId}&attrs=${attrs({ brand: 'apple' })}`)
      .expect(200)

    const titles = res.body.data.map((l: { title: string }) => l.title)
    expect(titles).toContain('Máy hãng apple bộ nhớ 256')
    expect(titles).not.toContain('Máy hãng samsung bộ nhớ 128')
  })

  it('nhiều thuộc tính cùng lúc là VÀ, không phải HOẶC', async () => {
    const res = await request(app)
      .get(
        `/api/v1/listings?category=${phoneCategoryId}&attrs=${attrs({
          brand: 'apple',
          storage: '128',
        })}`,
      )
      .expect(200)

    // Không tin nào vừa apple vừa 128 — gộp chung một `$elemMatch` sẽ ra kết quả này một cách
    // tình cờ, nên ca đối chứng ở test trên mới là thứ chứng minh `$and` đúng.
    expect(res.body.data).toHaveLength(0)
  })

  it('thiếu `category` thì 400 — không có template nào để đối chiếu key', async () => {
    const res = await request(app).get(`/api/v1/listings?attrs=${attrs({ brand: 'apple' })}`)
    expect(res.status).toBe(400)
  })

  it('key không `filterable` bị từ chối, không lặng lẽ bỏ qua', async () => {
    // `color` có trong template Điện thoại nhưng `filterable: false`.
    const res = await request(app).get(
      `/api/v1/listings?category=${phoneCategoryId}&attrs=${attrs({ color: 'đen' })}`,
    )
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('color')
  })

  it('JSON hỏng thì 400, KHÔNG âm thầm trả về cả kho', async () => {
    const res = await request(app).get(`/api/v1/listings?category=${phoneCategoryId}&attrs=%7Bbad`)
    expect(res.status).toBe(400)
  })
})
