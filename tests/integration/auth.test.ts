import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import type { Application } from 'express'

let app: Application
let mongod: MongoMemoryServer

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  process.env.MONGO_URI = mongod.getUri()
  process.env.JWT_SECRET = 'test_secret'
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret'

  await mongoose.connect(process.env.MONGO_URI)

  // import sau khi set env để env.ts validate đúng
  const { createApp } = await import('../../src/app')
  app = createApp()
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

describe('Auth flow', () => {
  const credentials = { email: 'test@example.com', password: 'password123' }

  it('registers a new user', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Tester', ...credentials })

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.data.tokens.accessToken).toBeDefined()
    expect(res.body.data.user.email).toBe(credentials.email)
  })

  it('rejects duplicate email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Tester2', ...credentials })
    expect(res.status).toBe(409)
  })

  it('logs in with valid credentials', async () => {
    const res = await request(app).post('/api/v1/auth/login').send(credentials)
    expect(res.status).toBe(200)
    expect(res.body.data.tokens.accessToken).toBeDefined()
  })

  it('rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: credentials.email, password: 'wrongpass' })
    expect(res.status).toBe(401)
  })
})
