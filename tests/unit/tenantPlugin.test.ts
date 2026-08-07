import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose, { Schema, Types } from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { tenantPlugin } from '../../src/common/tenant/tenantPlugin'
import { runWithTenant, runUnscoped } from '../../src/common/tenant/tenantContext'

// Cách ly tenant là ranh giới bảo mật — "review thấy ổn" không phải bằng chứng.
const ORG_A = new Types.ObjectId()
const ORG_B = new Types.ObjectId()

const chainSchema = new Schema({ name: String })
chainSchema.plugin(tenantPlugin, { chainReadable: true })
const ChainWidget = mongoose.model('ChainWidget', chainSchema)

const ownSchema = new Schema({ name: String })
ownSchema.plugin(tenantPlugin)
const OwnWidget = mongoose.model('OwnWidget', ownSchema)

let mongod: MongoMemoryServer

const inOrgA = <T>(fn: () => T) => runWithTenant({ ownOrgId: ORG_A, chainOrgIds: [ORG_A] }, fn)
const inChain = <T>(fn: () => T) =>
  runWithTenant({ ownOrgId: ORG_A, chainOrgIds: [ORG_A, ORG_B] }, fn)

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
    await Promise.all([ChainWidget.deleteMany({}), OwnWidget.deleteMany({})])
    await ChainWidget.insertMany([
      { organizationId: ORG_A, name: 'a1' },
      { organizationId: ORG_B, name: 'b1' },
    ])
    await OwnWidget.insertMany([
      { organizationId: ORG_A, name: 'a1' },
      { organizationId: ORG_B, name: 'b1' },
    ])
  })
})

describe('tenantPlugin - đọc', () => {
  it('find/countDocuments/distinct/aggregate đều bị chèn organizationId', async () => {
    await inOrgA(async () => {
      expect(await ChainWidget.find()).toHaveLength(1)
      expect(await ChainWidget.countDocuments()).toBe(1)
      expect(await ChainWidget.distinct('name')).toEqual(['a1'])
      expect(await ChainWidget.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }])).toEqual([
        { _id: null, n: 1 },
      ])
    })
  })

  it('chainReadable mở rộng đọc ra mọi org trong chain', async () => {
    await inChain(async () => {
      expect(await ChainWidget.find()).toHaveLength(2)
    })
  })

  it('schema không chainReadable vẫn chỉ thấy org của mình dù scope là cả chain', async () => {
    await inChain(async () => {
      expect(await OwnWidget.find()).toHaveLength(1)
    })
  })

  it('không có scope thì THROW, không trả về toàn bộ document', async () => {
    await expect(ChainWidget.find()).rejects.toThrow(/Missing tenant context/)
    await expect(ChainWidget.countDocuments()).rejects.toThrow(/Missing tenant context/)
    await expect(ChainWidget.create({ name: 'no-scope' })).rejects.toThrow(/Missing tenant context/)
  })

  it('estimatedDocumentCount bị chặn vì không nhận filter', async () => {
    await inOrgA(async () => {
      await expect(ChainWidget.estimatedDocumentCount()).rejects.toThrow(/estimatedDocumentCount/)
    })
  })
})

describe('tenantPlugin - ghi', () => {
  it('organizationId từ client bị bỏ qua, luôn lấy từ context', async () => {
    const created = await inOrgA(() => ChainWidget.create({ organizationId: ORG_B, name: 'spoof' }))
    expect(created.get('organizationId').toString()).toBe(ORG_A.toString())
  })

  // `.exec()` phải nằm TRONG callback: Query của Mongoose là lazy, trả nó ra ngoài rồi mới
  // await là chạy sau khi AsyncLocalStorage đã đóng scope.
  it('insertMany cũng ép organizationId về org của context', async () => {
    await inOrgA(() => ChainWidget.insertMany([{ organizationId: ORG_B, name: 'spoof-many' }]))

    const leaked = await runUnscoped('assert', () =>
      ChainWidget.countDocuments({ organizationId: ORG_B, name: 'spoof-many' }).exec(),
    )
    expect(leaked).toBe(0)
  })

  it('scope nhiều org (chain) KHÔNG cho ghi lan sang org khác', async () => {
    await inChain(() => ChainWidget.updateMany({}, { $set: { name: 'rewritten' } }).exec())

    const untouched = await runUnscoped('assert', () =>
      ChainWidget.findOne({ organizationId: ORG_B }).exec(),
    )
    expect(untouched?.get('name')).toBe('b1')
  })

  it('delete cũng bị giới hạn trong org của mình', async () => {
    await inChain(() => ChainWidget.deleteMany({}).exec())

    const remaining = await runUnscoped('assert', () => ChainWidget.find().exec())
    expect(remaining).toHaveLength(1)
    expect(remaining[0].get('organizationId').toString()).toBe(ORG_B.toString())
  })

  it('runUnscoped từ chối ghi document không mang organizationId', async () => {
    await expect(
      runUnscoped('bad write', () => ChainWidget.create({ name: 'orphan' })),
    ).rejects.toThrow(/organizationId/)
  })
})
