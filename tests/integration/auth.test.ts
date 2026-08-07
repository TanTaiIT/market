import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'

let app: Application
let mongod: MongoMemoryReplSet

beforeAll(async () => {
  // Đăng ký tạo Organization + owner trong một transaction -> bắt buộc replica set.
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGO_URI = mongod.getUri()
  process.env.JWT_SECRET = 'test_secret'
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret'
  delete process.env.APP_BASE_DOMAIN

  await mongoose.connect(process.env.MONGO_URI)

  // import sau khi set env để env.ts validate đúng
  const { createApp } = await import('../../src/app')
  app = createApp()
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Auth flow', () => {
  const credentials = { email: 'test@example.com', password: 'password123' }
  const organization = { organizationName: 'Tester Org', organizationSlug: 'tester-org' }

  it('registers a new organization with its first owner', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...organization, name: 'Tester', ...credentials })

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.data.tokens.accessToken).toBeDefined()
    expect(res.body.data.user.email).toBe(credentials.email)
    expect(res.body.data.user.organizationId).toBeDefined()
    expect(res.body.data.user.role).toBe('owner')
  })

  it('rejects duplicate organization slug', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        ...organization,
        name: 'Tester2',
        email: 'other@example.com',
        password: 'password123',
      })
    expect(res.status).toBe(409)
  })

  it('logs in with valid credentials scoped to the organization', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ orgSlug: organization.organizationSlug, ...credentials })
    expect(res.status).toBe(200)
    expect(res.body.data.tokens.accessToken).toBeDefined()
  })

  it('rejects login without an organization', async () => {
    const res = await request(app).post('/api/v1/auth/login').send(credentials)
    expect(res.status).toBe(401)
  })

  it('rejects wrong password', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      orgSlug: organization.organizationSlug,
      email: credentials.email,
      password: 'wrongpass',
    })
    expect(res.status).toBe(401)
  })
})
