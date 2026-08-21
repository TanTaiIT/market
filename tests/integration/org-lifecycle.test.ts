import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createOrg,
  createTestApp,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let schoolOwner: TestUser
let flatOwner: TestUser
let schoolId = ''

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  schoolOwner = await registerUser(app, 'owner@school.local', 'School Owner')
  flatOwner = await registerUser(app, 'owner@flat.local', 'Flat Owner')

  schoolId = (
    await createOrg(app, master.token, {
      name: 'Trường Có Lớp',
      slug: 'truong-co-lop',
      ownerEmail: schoolOwner.email,
      orgType: 'school',
    })
  ).id

  await createOrg(app, master.token, {
    name: 'Nhóm Phẳng',
    slug: 'nhom-phang',
    ownerEmail: flatOwner.email,
    orgType: 'community',
  })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

/**
 * `capabilities` là ranh giới giữa "tổng quát hoá thật" và "thêm một cột rồi vẫn `if (orgType
 * === 'school')` khắp nơi". Nó chỉ có nghĩa khi có ai đó ĐỌC và từ chối dựa trên nó.
 */
describe('capabilities quyết định org có nhóm con hay không', () => {
  it('org loại trường (preset hasUnits=true) tạo được nhóm con', async () => {
    const res = await request(app)
      .post('/api/v1/org-units')
      .set(orgAuth(schoolOwner.token, 'truong-co-lop'))
      .send({ name: '10A1' })
    expect(res.status).toBe(201)
  })

  it('org phẳng (preset hasUnits=false) bị từ chối, kèm lý do đọc được', async () => {
    const res = await request(app)
      .post('/api/v1/org-units')
      .set(orgAuth(flatOwner.token, 'nhom-phang'))
      .send({ name: 'Tổ 1' })

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/hasUnits/)
  })
})

/**
 * Client dựng bộ chuyển tổ chức từ đây: org hoạt động do client chỉ ra bằng header, nên không
 * có danh sách này thì người thuộc nhiều org không biết mình được gửi slug nào.
 */
describe('GET /organizations/mine', () => {
  it('trả đúng các tổ chức mình là thành viên, kèm vai trò', async () => {
    const res = await request(app)
      .get('/api/v1/organizations/mine')
      .set(`Authorization`, `Bearer ${schoolOwner.token}`)
      .expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ slug: 'truong-co-lop', role: 'owner' })
  })

  it('người chưa thuộc tổ chức nào nhận mảng rỗng, không phải lỗi', async () => {
    const nobody = await registerUser(app, 'nobody@school.local', 'Nobody')
    const res = await request(app)
      .get('/api/v1/organizations/mine')
      .set('Authorization', `Bearer ${nobody.token}`)
      .expect(200)

    expect(res.body.data).toEqual([])
  })
})

/**
 * Đổi slug mà URL cũ chết thì bảng alias chỉ là dữ liệu ghi ra rồi không ai đọc.
 */
describe('Slug cũ vẫn dẫn về đúng tổ chức sau khi đổi tên', () => {
  it('gọi API bằng slug cũ vẫn vào đúng org', async () => {
    await request(app)
      .patch(`/api/v1/organizations/${schoolId}/slug`)
      .set('Authorization', `Bearer ${master.token}`)
      .send({ slug: 'thpt-co-lop' })
      .expect(200)

    const viaNew = await request(app)
      .get('/api/v1/org-units')
      .set(orgAuth(schoolOwner.token, 'thpt-co-lop'))
      .expect(200)

    const viaOld = await request(app)
      .get('/api/v1/org-units')
      .set(orgAuth(schoolOwner.token, 'truong-co-lop'))
      .expect(200)

    expect(viaOld.body.data).toEqual(viaNew.body.data)
    expect(viaOld.body.data[0].name).toBe('10A1')
  })

  it('slug chưa từng tồn tại vẫn bị từ chối', async () => {
    const res = await request(app)
      .get('/api/v1/org-units')
      .set(orgAuth(schoolOwner.token, 'khong-co-that'))
    expect(res.status).toBe(403)
  })
})

/**
 * Dropdown chọn org. Trước đây nhánh tên là regex không neo đầu trên `name` — không index,
 * nên cả câu `$or` quét trọn collection cho mỗi ký tự người dùng gõ. Nay tra theo TỪ đã chuẩn
 * hoá (`nameTokens`), mỗi từ có bounds thật trên index multikey.
 */
const names = (res: { body: { data: { name: string }[] } }) => res.body.data.map((o) => o.name)

describe('GET /organizations/lookup', () => {
  const lookup = (q: string) =>
    request(app)
      .get(`/api/v1/organizations/lookup?q=${encodeURIComponent(q)}`)
      .set({ Authorization: `Bearer ${master.token}` })

  it('gõ một từ GIỮA tên vẫn ra — ca mà tiền tố cả chuỗi không giải được', async () => {
    const res = await lookup('lop').expect(200)
    expect(names(res)).toContain('Trường Có Lớp')
  })

  it('gõ không dấu vẫn ra', async () => {
    expect(names(await lookup('truong').expect(200))).toContain('Trường Có Lớp')
    expect(names(await lookup('phang').expect(200))).toContain('Nhóm Phẳng')
  })

  it('nhiều từ phải khớp ĐỦ, không phải khớp một trong số đó', async () => {
    const res = await lookup('nhom phang').expect(200)
    expect(names(res)).toEqual(['Nhóm Phẳng'])

    // "nhom" khớp "Nhóm Phẳng" nhưng "lop" thì không — đủ để loại nó ra.
    expect(names(await lookup('nhom lop').expect(200))).toHaveLength(0)
  })

  it('tra được cả theo slug', async () => {
    expect(names(await lookup('truongcolop').expect(200))).toContain('Trường Có Lớp')
  })

  it('không khớp gì thì rỗng, không phải lỗi', async () => {
    expect(names(await lookup('khongcogi').expect(200))).toHaveLength(0)
  })
})
