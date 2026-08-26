import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  addMember,
  createOrg,
  createTestApp,
  makeMaster,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

/**
 * `GET /organizations/mine` nạp org theo LÔ, không phải một truy vấn cho mỗi org.
 *
 * Test đếm số lượt gọi repository chứ không đo thời gian: thời gian trên máy CI dao động quá
 * lớn để làm chốt, còn "bao nhiêu lượt truy vấn" thì là con số xác định. Đây cũng là điều duy
 * nhất phân biệt bản đã sửa với bản cũ — cả hai trả về DỮ LIỆU GIỐNG HỆT nhau, nên không có
 * assertion nào về nội dung bắt được sự khác biệt.
 */

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let member: TestUser

const ORG_COUNT = 4

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  master = await makeMaster(app)
  member = await registerUser(app, 'nhieu-truong@example.com', 'Người nhiều trường')

  // Bốn org, cùng một người là thành viên của cả bốn — đủ để 1+N và 1+1 tách hẳn nhau.
  for (let i = 0; i < ORG_COUNT; i += 1) {
    const owner = await registerUser(app, `chu${i}@truong.local`, `Chủ ${i}`)
    const org = await createOrg(app, master.token, {
      name: `Trường Số ${i}`,
      slug: `truong-so-${i}`,
      ownerEmail: owner.email,
    })
    await addMember(member.id, org.id)
  }
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('GET /organizations/mine — nạp theo lô', () => {
  it('trả đủ cả bốn tổ chức', async () => {
    const res = await request(app)
      .get('/api/v1/organizations/mine')
      .set('Authorization', `Bearer ${member.token}`)
      .expect(200)

    expect(res.body.data).toHaveLength(ORG_COUNT)
    expect(res.body.data.map((o: { slug: string }) => o.slug).sort()).toEqual([
      'truong-so-0',
      'truong-so-1',
      'truong-so-2',
      'truong-so-3',
    ])
  })

  /**
   * Chốt thật của bài test. Bản cũ gọi `findById` một lần cho MỖI membership; bản mới gọi
   * `findByIds` đúng một lần. Đếm lời gọi là cách duy nhất nhìn thấy khác biệt đó từ ngoài.
   */
  it('gọi repository ĐÚNG MỘT lần, không phải một lần mỗi tổ chức', async () => {
    const { organizationRepository } =
      await import('../../src/features/organization/organization.repository')
    const batch = vi.spyOn(organizationRepository, 'findByIds')
    const single = vi.spyOn(organizationRepository, 'findById')

    await request(app)
      .get('/api/v1/organizations/mine')
      .set('Authorization', `Bearer ${member.token}`)
      .expect(200)

    expect(batch).toHaveBeenCalledTimes(1)
    // Vế này mới là thứ bắt được hồi quy: thêm lại một `findById` trong vòng lặp thì con số
    // này nhảy lên 4 trong khi mọi assertion về nội dung vẫn xanh.
    expect(single).not.toHaveBeenCalled()

    batch.mockRestore()
    single.mockRestore()
  })

  it('org bị xoá mềm rơi khỏi danh sách thay vì thành một dòng rỗng', async () => {
    const { Organization } = await import('../../src/features/organization/organization.model')
    await Organization.updateOne({ slug: 'truong-so-0' }, { deletedAt: new Date() }).exec()

    const res = await request(app)
      .get('/api/v1/organizations/mine')
      .set('Authorization', `Bearer ${member.token}`)
      .expect(200)

    const slugs = res.body.data.map((o: { slug: string }) => o.slug)
    expect(slugs).not.toContain('truong-so-0')
    expect(slugs).toHaveLength(ORG_COUNT - 1)
  })
})
