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
    expect(res.body.data[0]).toMatchObject({ slug: 'truong-co-lop', role: 'admin' })
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

/**
 * Tạo org và trao quyền phụ trách là HAI việc tách rời.
 *
 * Bản cũ gộp làm một: `POST /organizations` bắt buộc `ownerEmail`, nên không tạo nổi org khi
 * chưa biết ai sẽ trông nó. Giờ master dựng org theo danh sách trước, tìm được người thì trao.
 */
describe('Tạo org rồi trao quyền phụ trách', () => {
  let orphanId = ''
  let admin: TestUser

  beforeAll(async () => {
    admin = await registerUser(app, 'admin@vo-chu.local', 'Người phụ trách')
  }, 60_000)

  it('tạo org KHÔNG cần người phụ trách, org nằm ở pending_admin', async () => {
    const res = await request(app)
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${master.token}`)
      .send({ name: 'Trường Chưa Có Chủ', slug: 'truong-vo-chu' })

    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('pending_admin')
    orphanId = res.body.data.id
  })

  it('org chưa có người phụ trách thì không ai vào được', async () => {
    // `findActiveById` chỉ thấy org `active`, nên slug này không resolve ra tenant nào.
    const res = await request(app)
      .get('/api/v1/moderation/listings')
      .set(orgAuth(admin.token, 'truong-vo-chu'))

    expect(res.status).toBe(403)
  })

  it('email chưa có tài khoản thì 404, không tạo gì cả', async () => {
    const res = await request(app)
      .post(`/api/v1/organizations/${orphanId}/admin`)
      .set('Authorization', `Bearer ${master.token}`)
      .send({ email: 'khong-ton-tai@vo-chu.local' })

    expect(res.status).toBe(404)
  })

  it('không phải master thì không trao quyền được', async () => {
    const res = await request(app)
      .post(`/api/v1/organizations/${orphanId}/admin`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ email: admin.email })

    expect(res.status).toBe(403)
  })

  it('trao quyền: org mở cửa, người đó thành admin và vào được bàn duyệt', async () => {
    const granted = await request(app)
      .post(`/api/v1/organizations/${orphanId}/admin`)
      .set('Authorization', `Bearer ${master.token}`)
      .send({ email: admin.email })

    expect(granted.status).toBe(200)
    expect(granted.body.data.status).toBe('active')

    const desk = await request(app)
      .get('/api/v1/moderation/listings')
      .set(orgAuth(admin.token, 'truong-vo-chu'))
    expect(desk.status).toBe(200)

    const roster = await request(app)
      .get('/api/v1/memberships')
      .set(orgAuth(admin.token, 'truong-vo-chu'))
      .expect(200)
    expect(roster.body.data).toEqual([expect.objectContaining({ userId: admin.id, role: 'admin' })])
  }, 60_000)

  it('trao lại cho đúng người đó là thao tác vô hại', async () => {
    const again = await request(app)
      .post(`/api/v1/organizations/${orphanId}/admin`)
      .set('Authorization', `Bearer ${master.token}`)
      .send({ email: admin.email })

    expect(again.status).toBe(200)

    const roster = await request(app)
      .get('/api/v1/memberships')
      .set(orgAuth(admin.token, 'truong-vo-chu'))
      .expect(200)
    expect(roster.body.data).toHaveLength(1)
  })
})

/**
 * Hồ sơ nhóm — đường duy nhất trong feature này mà ADMIN ORG gọi được, phần còn lại của master.
 */
describe('Sửa hồ sơ tổ chức', () => {
  const CLOUD = 'https://res.cloudinary.com/demo/image/upload/v1/org/avatar.jpg'
  let member: TestUser
  /** Đọc slug hiện tại thay vì hardcode: test đổi slug ở trên đã dời nó đi một lần rồi. */
  let slug = ''

  beforeAll(async () => {
    const { addMember } = await import('../helpers/fixtures')
    member = await registerUser(app, 'thanhvien@school.local', 'Thành viên thường')
    await addMember(member.id, schoolId)

    const mine = await request(app)
      .get('/api/v1/organizations/mine')
      .set('Authorization', `Bearer ${schoolOwner.token}`)
      .expect(200)
    slug = mine.body.data.find((o: { id: string }) => o.id === schoolId).slug
  }, 60_000)

  it('admin sửa được tên, mô tả và ảnh', async () => {
    const res = await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(schoolOwner.token, slug))
      .send({ name: 'Trường Có Lớp (mới)', description: 'Nhóm mua bán nội bộ', avatarUrl: CLOUD })

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      name: 'Trường Có Lớp (mới)',
      description: 'Nhóm mua bán nội bộ',
      avatarUrl: CLOUD,
    })
  })

  it('đổi tên xong vẫn tra được org trong dropdown', async () => {
    // `nameTokens` phải dựng lại theo tên mới, không thì org biến mất khỏi ô tìm kiếm.
    const res = await request(app).get('/api/v1/organizations/lookup?q=moi').expect(200)
    expect(res.body.data.map((o: { slug: string }) => o.slug)).toContain(slug)
  })

  it('gỡ ảnh bằng null, bỏ trống thì giữ nguyên', async () => {
    const res = await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(schoolOwner.token, slug))
      .send({ avatarUrl: null })
      .expect(200)

    expect(res.body.data.avatarUrl).toBeNull()
    expect(res.body.data.description).toBe('Nhóm mua bán nội bộ')
  })

  it('ảnh ngoài Cloudinary bị từ chối', async () => {
    const res = await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(schoolOwner.token, slug))
      .send({ avatarUrl: 'https://evil.example.com/anh.jpg' })

    expect(res.status).toBe(400)
  })

  it('không sửa được slug qua đường này', async () => {
    const res = await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(schoolOwner.token, slug))
      .send({ slug: 'slug-moi' })

    expect(res.status).toBe(400)
  })

  /** Nội quy đọc lại qua hồ sơ nhóm: `PATCH` trả DTO tóm tắt, cố tình không mang `rules`. */
  const rulesOf = async () => {
    const res = await request(app).get(`/api/v1/organizations/profile/${slug}`).expect(200)
    return res.body.data.rules as string[]
  }

  it('sửa được nội quy nhóm — thay CẢ mảng', async () => {
    await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(schoolOwner.token, slug))
      .send({ rules: ['Không bán hàng giả', 'Ghi rõ tình trạng sản phẩm'] })
      .expect(200)

    expect(await rulesOf()).toEqual(['Không bán hàng giả', 'Ghi rõ tình trạng sản phẩm'])
  })

  it('mảng rỗng là XOÁ HẾT nội quy, khác với không gửi field', async () => {
    await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(schoolOwner.token, slug))
      .send({ rules: [] })
      .expect(200)
    expect(await rulesOf()).toEqual([])

    await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(schoolOwner.token, slug))
      .send({ rules: ['Chỉ một dòng'] })
      .expect(200)
    expect(await rulesOf()).toEqual(['Chỉ một dòng'])

    // Không gửi `rules` thì nó phải ở NGUYÊN TRẠNG — đây là chỗ dễ viết thành `|| []` rồi
    // xoá sạch nội quy của nhóm mỗi lần ai đó chỉ sửa mô tả.
    await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(schoolOwner.token, slug))
      .send({ description: 'Chỉ sửa mô tả' })
      .expect(200)
    expect(await rulesOf()).toEqual(['Chỉ một dòng'])
  })

  it('quá 10 dòng nội quy thì từ chối', async () => {
    const res = await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(schoolOwner.token, slug))
      .send({ rules: Array.from({ length: 11 }, (_, n) => `Điều ${n + 1}`) })

    expect(res.status).toBe(400)
  })

  it('dòng nội quy rỗng bị từ chối — không để nhóm có một gạch đầu dòng trống', async () => {
    const res = await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(schoolOwner.token, slug))
      .send({ rules: ['Điều hợp lệ', '   '] })

    expect(res.status).toBe(400)
  })

  it('thành viên thường không sửa được hồ sơ nhóm', async () => {
    const res = await request(app)
      .patch('/api/v1/organizations/current')
      .set(orgAuth(member.token, slug))
      .send({ description: 'tôi tự sửa' })

    expect(res.status).toBe(403)
  })
})

/**
 * Mã nhóm thay slug làm đường vào.
 *
 * Slug là địa chỉ công khai — ai nhìn thấy tên tổ chức cũng gõ được đơn xin vào. Mã chỉ người
 * được đưa mới có, và xoay được khi rò.
 */
describe('Mã nhóm', () => {
  let code = ''
  let outsider: TestUser

  beforeAll(async () => {
    const { joinCodeOf } = await import('../helpers/fixtures')
    outsider = await registerUser(app, 'nguoi-la@ma-nhom.local', 'Người lạ')
    const mine = await request(app)
      .get('/api/v1/organizations/mine')
      .set('Authorization', `Bearer ${schoolOwner.token}`)
      .expect(200)
    code = await joinCodeOf(mine.body.data.find((o: { id: string }) => o.id === schoolId).slug)
  }, 60_000)

  it('mã sinh sẵn lúc tạo org, không có ký tự dễ nhìn nhầm', () => {
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/)
  })

  it('người cầm mã xem được thẻ nhóm mà không cần đăng nhập', async () => {
    const res = await request(app).get(`/api/v1/organizations/by-code/${code}`).expect(200)

    expect(res.body.data).toMatchObject({ memberCount: expect.any(Number) })
    expect(res.body.data.name).toBeTruthy()
    // Thẻ công khai không được lộ đường nào khác để lần ra org.
    expect(res.body.data.id).toBeUndefined()
    expect(res.body.data.slug).toBeUndefined()
    expect(res.body.data.joinCode).toBeUndefined()
  })

  it('gõ mã thường, có gạch và khoảng trắng vẫn vào đúng nhóm', async () => {
    const messy = `${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()}`
    const res = await request(app)
      .post('/api/v1/join-requests')
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ code: messy, claimedName: 'Người lạ' })

    expect(res.status).toBe(201)
  })

  it('thẻ nhóm chấp nhận đúng thứ mà đơn gia nhập chấp nhận', async () => {
    // Bug đã từng có: `by-code` không chuẩn hoá còn đơn gia nhập thì có, nên cùng một chuỗi
    // dán vào cho ra 404 ở bước xem trước và 201 ở bước xin vào — mà luồng thật là xem rồi mới bấm.
    const messy = `${code.slice(0, 3).toLowerCase()} ${code.slice(3).toLowerCase()}`
    const res = await request(app).get(`/api/v1/organizations/by-code/${encodeURIComponent(messy)}`)

    expect(res.status).toBe(200)
  })

  it('mã sai thì 404', async () => {
    const res = await request(app).get('/api/v1/organizations/by-code/ZZZZZZ')
    expect(res.status).toBe(404)
  })

  it('xoay mã: mã cũ chết ngay', async () => {
    const mine = await request(app)
      .get('/api/v1/organizations/mine')
      .set('Authorization', `Bearer ${schoolOwner.token}`)
      .expect(200)
    const slug = mine.body.data.find((o: { id: string }) => o.id === schoolId).slug

    const rotated = await request(app)
      .post('/api/v1/organizations/current/join-code')
      .set(orgAuth(schoolOwner.token, slug))
      .expect(200)

    expect(rotated.body.data.joinCode).not.toBe(code)
    await request(app).get(`/api/v1/organizations/by-code/${code}`).expect(404)
    await request(app)
      .get(`/api/v1/organizations/by-code/${rotated.body.data.joinCode}`)
      .expect(200)
  })

  it('người ngoài không xoay được mã', async () => {
    const mine = await request(app)
      .get('/api/v1/organizations/mine')
      .set(`Authorization`, `Bearer ${schoolOwner.token}`)
      .expect(200)
    const slug = mine.body.data.find((o: { id: string }) => o.id === schoolId).slug

    // Slug THẬT: 403 phải đến từ thiếu quyền, không phải từ việc slug không resolve ra org nào.
    const res = await request(app)
      .post('/api/v1/organizations/current/join-code')
      .set(orgAuth(outsider.token, slug))

    expect(res.status).toBe(403)
  })
})
