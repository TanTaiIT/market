import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose, { Schema, Types } from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { tenantPlugin } from '../../src/common/tenant/tenantPlugin'
import { runWithTenant, runUnscoped } from '../../src/common/tenant/tenantContext'

// Cách ly tenant là ranh giới bảo mật — "review thấy ổn" không phải bằng chứng.
const ORG_A = new Types.ObjectId()
const ORG_B = new Types.ObjectId()

const widgetSchema = new Schema({ name: String })
widgetSchema.plugin(tenantPlugin)
const Widget = mongoose.model('Widget', widgetSchema)

let mongod: MongoMemoryServer

const inOrgA = <T>(fn: () => T) =>
  runWithTenant({ ownOrgId: ORG_A, readableOrgIds: [ORG_A], publicAxis: null }, fn)
// Scope đọc nhiều org: middleware hiện không sinh ra ca này, nhưng plugin vẫn phải giữ đúng
// ngữ nghĩa "đọc rộng, ghi hẹp" — trục công khai dựng trên chính ngữ nghĩa đó.
const inWideRead = <T>(fn: () => T) =>
  runWithTenant({ ownOrgId: ORG_A, readableOrgIds: [ORG_A, ORG_B], publicAxis: null }, fn)

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri())
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await runUnscoped('test fixture', async () => {
    await Widget.deleteMany({})
    await Widget.insertMany([
      { organizationId: ORG_A, name: 'a1' },
      { organizationId: ORG_B, name: 'b1' },
    ])
  })
})

describe('tenantPlugin - đọc', () => {
  it('find/countDocuments/distinct/aggregate đều bị chèn organizationId', async () => {
    await inOrgA(async () => {
      expect(await Widget.find()).toHaveLength(1)
      expect(await Widget.countDocuments()).toBe(1)
      expect(await Widget.distinct('name')).toEqual(['a1'])
      expect(await Widget.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }])).toEqual([
        { _id: null, n: 1 },
      ])
    })
  })

  it('readableOrgIds nhiều org thì đọc được cả hai', async () => {
    await inWideRead(async () => {
      expect(await Widget.find()).toHaveLength(2)
    })
  })

  it('không có scope thì THROW, không trả về toàn bộ document', async () => {
    await expect(Widget.find()).rejects.toThrow(/Missing tenant context/)
    await expect(Widget.countDocuments()).rejects.toThrow(/Missing tenant context/)
    await expect(Widget.create({ name: 'no-scope' })).rejects.toThrow(/Missing tenant context/)
  })

  it('estimatedDocumentCount bị chặn vì không nhận filter', async () => {
    await inOrgA(async () => {
      await expect(Widget.estimatedDocumentCount()).rejects.toThrow(/estimatedDocumentCount/)
    })
  })
})

describe('tenantPlugin - ghi', () => {
  it('organizationId từ client bị bỏ qua, luôn lấy từ context', async () => {
    const created = await inOrgA(() => Widget.create({ organizationId: ORG_B, name: 'spoof' }))
    expect(created.get('organizationId').toString()).toBe(ORG_A.toString())
  })

  // `.exec()` phải nằm TRONG callback: Query của Mongoose là lazy, trả nó ra ngoài rồi mới
  // await là chạy sau khi AsyncLocalStorage đã đóng scope.
  it('insertMany cũng ép organizationId về org của context', async () => {
    await inOrgA(() => Widget.insertMany([{ organizationId: ORG_B, name: 'spoof-many' }]))

    const leaked = await runUnscoped('assert', () =>
      Widget.countDocuments({ organizationId: ORG_B, name: 'spoof-many' }).exec(),
    )
    expect(leaked).toBe(0)
  })

  it('scope đọc nhiều org KHÔNG cho ghi lan sang org khác', async () => {
    await inWideRead(() => Widget.updateMany({}, { $set: { name: 'rewritten' } }).exec())

    const untouched = await runUnscoped('assert', () =>
      Widget.findOne({ organizationId: ORG_B }).exec(),
    )
    expect(untouched?.get('name')).toBe('b1')
  })

  it('delete cũng bị giới hạn trong org của mình', async () => {
    await inWideRead(() => Widget.deleteMany({}).exec())

    const remaining = await runUnscoped('assert', () => Widget.find().exec())
    expect(remaining).toHaveLength(1)
    expect(remaining[0].get('organizationId').toString()).toBe(ORG_B.toString())
  })

  it('runUnscoped từ chối ghi document không mang organizationId', async () => {
    await expect(runUnscoped('bad write', () => Widget.create({ name: 'orphan' }))).rejects.toThrow(
      /organizationId/,
    )
  })
})
