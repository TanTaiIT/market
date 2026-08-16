import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createOrg,
  createTestApp,
  grantRole,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet

let master: TestUser
let owner: TestUser
/** Staff chỉ phụ trách nhóm 10A1 — nhân vật chính của cả file này. */
let unitStaff: TestUser
let memberInUnit: TestUser
let memberOutsideUnit: TestUser
let orphan: TestUser

let orgId = ''
let unitId = ''

const SLUG = 'notice-org'
const asOwner = () => orgAuth(owner.token, SLUG)
const asStaff = () => orgAuth(unitStaff.token, SLUG)

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  owner = await registerUser(app, 'owner@notice.local', 'Chủ tổ chức')
  orgId = (
    await createOrg(app, master.token, {
      name: 'Trường Thông Báo',
      slug: SLUG,
      ownerEmail: owner.email,
      // `school` mới bật `capabilities.hasUnits` — org phẳng thì cả file này vô nghĩa.
      orgType: 'school',
      provinceCode: 'Hồ Chí Minh',
    })
  ).id

  const unit = await request(app)
    .post('/api/v1/org-units')
    .set(asOwner())
    .send({ name: '10A1' })
    .expect(201)
  unitId = unit.body.data.id

  unitStaff = await registerUser(app, 'staff@notice.local', 'Phụ trách 10A1')
  await addMember(unitStaff.id, orgId, { unitId })
  await grantRole({ userId: unitStaff.id, role: 'staff', scopeType: 'org_unit', orgId, unitId })

  memberInUnit = await registerUser(app, 'in@notice.local', 'Học sinh 10A1')
  await addMember(memberInUnit.id, orgId, { unitId })

  memberOutsideUnit = await registerUser(app, 'out@notice.local', 'Học sinh lớp khác')
  await addMember(memberOutsideUnit.id, orgId)

  orphan = await registerUser(app, 'orphan@notice.local', 'Không thuộc tổ chức nào')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Phạm vi gửi bám theo phạm vi được cấp', () => {
  it('quản lý cấp org gửi được cho cả tổ chức', async () => {
    const res = await request(app)
      .post('/api/v1/notifications')
      .set(asOwner())
      .send({ title: 'Nghỉ lễ', body: 'Trường nghỉ thứ hai tuần sau.' })

    expect(res.status).toBe(201)
    expect(res.body.data.unitId).toBeNull()
  })

  it('staff của một nhóm KHÔNG gửi được cho cả tổ chức', async () => {
    const res = await request(app)
      .post('/api/v1/notifications')
      .set(asStaff())
      .send({ title: 'Thông báo toàn trường', body: 'Gửi vượt phạm vi.' })

    // Đây là ca mà `requireOrgModerator` ở tầng route cho qua: nó chỉ hỏi "có duyệt được thứ
    // gì đó trong org không". Chặn thật nằm ở service.
    expect(res.status).toBe(403)
  })

  it('staff gửi được cho đúng nhóm của mình', async () => {
    const res = await request(app)
      .post('/api/v1/notifications')
      .set(asStaff())
      .send({ title: 'Họp lớp 10A1', body: 'Chiều thứ sáu ở phòng A2.', unitId })

    expect(res.status).toBe(201)
    expect(res.body.data.unitId).toBe(unitId)
  })

  it('nhóm không tồn tại thì 400 chứ không tạo thông báo mồ côi', async () => {
    const res = await request(app).post('/api/v1/notifications').set(asOwner()).send({
      title: 'Nhóm ma',
      body: 'Không nhóm nào nhận.',
      unitId: new mongoose.Types.ObjectId().toString(),
    })

    expect(res.status).toBe(400)
  })

  it('thành viên thường không gửi được gì', async () => {
    const res = await request(app)
      .post('/api/v1/notifications')
      .set(orgAuth(memberInUnit.token, SLUG))
      .send({ title: 'Tự phát', body: 'Không có quyền.' })

    expect(res.status).toBe(403)
  })
})

describe('Người đọc chỉ thấy phần dành cho mình', () => {
  it('người trong nhóm thấy cả thông báo toàn trường lẫn thông báo của nhóm', async () => {
    const res = await request(app)
      .get('/api/v1/notifications')
      .set(orgAuth(memberInUnit.token, SLUG))
      .expect(200)

    const titles = res.body.data.map((n: { title: string }) => n.title)
    expect(titles).toContain('Nghỉ lễ')
    expect(titles).toContain('Họp lớp 10A1')
  })

  it('người ngoài nhóm KHÔNG thấy thông báo của nhóm đó', async () => {
    const res = await request(app)
      .get('/api/v1/notifications')
      .set(orgAuth(memberOutsideUnit.token, SLUG))
      .expect(200)

    const titles = res.body.data.map((n: { title: string }) => n.title)
    expect(titles).toContain('Nghỉ lễ')
    expect(titles).not.toContain('Họp lớp 10A1')
    // Tổng phải khớp với thứ trả về, nếu không thì phân trang nói dối ở trang sau.
    expect(res.body.meta.total).toBe(titles.length)
  })

  it('tài khoản chưa thuộc tổ chức nào nhận danh sách rỗng, KHÔNG phải lỗi', async () => {
    const res = await request(app)
      .get('/api/v1/notifications')
      .set({ Authorization: `Bearer ${orphan.token}` })

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

/**
 * `inbox` trả lời "tôi nhận được gì", `managed` trả lời "tôi gửi được tới đâu". Bàn quản trị
 * cần cái thứ hai: quản lý cấp org không đứng trong nhóm nào, nên `inbox` của họ KHÔNG chứa
 * thông báo họ vừa gửi cho một nhóm — panel "Đã gửi gần đây" sẽ báo gửi xong rồi hiện danh
 * sách không có nó.
 */
describe('scope=managed — thứ tôi gửi được tới', () => {
  it('quản lý cấp org thấy cả thông báo gửi cho nhóm mà họ không thuộc', async () => {
    const inbox = await request(app).get('/api/v1/notifications').set(asOwner()).expect(200)
    expect(inbox.body.data.map((n: { title: string }) => n.title)).not.toContain('Họp lớp 10A1')

    const managed = await request(app)
      .get('/api/v1/notifications?scope=managed')
      .set(asOwner())
      .expect(200)
    expect(managed.body.data.map((n: { title: string }) => n.title)).toContain('Họp lớp 10A1')
  })

  it('staff nhóm chỉ thấy phần trong tầm với — không thành đường vòng đọc nhóm khác', async () => {
    const otherUnit = await request(app)
      .post('/api/v1/org-units')
      .set(asOwner())
      .send({ name: '10A2' })
      .expect(201)

    await request(app)
      .post('/api/v1/notifications')
      .set(asOwner())
      .send({
        title: 'Riêng 10A2',
        body: 'Không phải việc của 10A1.',
        unitId: otherUnit.body.data.id,
      })
      .expect(201)

    const res = await request(app)
      .get('/api/v1/notifications?scope=managed')
      .set(asStaff())
      .expect(200)

    const titles = res.body.data.map((n: { title: string }) => n.title)
    expect(titles).toContain('Họp lớp 10A1')
    expect(titles).not.toContain('Riêng 10A2')
  })
})

describe('Không rò `readBy` ra ngoài', () => {
  it('response mang isRead/readCount thay cho danh sách người đã đọc', async () => {
    const before = await request(app)
      .get('/api/v1/notifications')
      .set(orgAuth(memberInUnit.token, SLUG))
      .expect(200)

    const notice = before.body.data.find((n: { title: string }) => n.title === 'Nghỉ lễ')
    expect(notice.readBy).toBeUndefined()
    expect(notice).toMatchObject({ isRead: false, readCount: 0 })

    await request(app)
      .patch(`/api/v1/notifications/${notice.id}/read`)
      .set(orgAuth(memberInUnit.token, SLUG))
      .expect(200)

    const after = await request(app)
      .get('/api/v1/notifications')
      .set(orgAuth(memberInUnit.token, SLUG))
      .expect(200)
    expect(after.body.data.find((n: { id: string }) => n.id === notice.id)).toMatchObject({
      isRead: true,
      readCount: 1,
    })

    // `isRead` là quan hệ giữa NGƯỜI và thông báo: người khác đọc không làm nó thành đã đọc
    // với mình, nhưng `readCount` thì chung.
    const other = await request(app)
      .get('/api/v1/notifications')
      .set(orgAuth(memberOutsideUnit.token, SLUG))
      .expect(200)
    expect(other.body.data.find((n: { id: string }) => n.id === notice.id)).toMatchObject({
      isRead: false,
      readCount: 1,
    })
  })
})
