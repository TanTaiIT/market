import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createCategory,
  createOrg,
  createTestApp,
  makeMaster,
  orgAuth,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'
import {
  CLEANUP,
  CleanupConfig,
  uploadCleanupService,
} from '../../src/features/upload/upload.cleanup.service'

let app: Application
let mongod: MongoMemoryReplSet
let seller: TestUser

const CLOUD = 'test-cloud'
const cfg: CleanupConfig = {
  cloudName: CLOUD,
  apiKey: 'key',
  apiSecret: 'secret',
  folder: 'ghim',
}

const url = (id: string) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/${id}.jpg`

beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()

  const categoryId = await createCategory('Đồ dùng', 'do-dung')
  const master = await makeMaster(app)
  seller = await registerUser(app, 'seller@cleanup.local', 'Người bán')
  await createOrg(app, master.token, {
    name: 'Org dọn ảnh',
    key: 'don-anh',
    ownerEmail: seller.email,
  })

  // Một tin thật giữ 2 ảnh + avatar user — nguồn "còn chủ" cho các test bên dưới.
  await request(app)
    .post('/api/v1/listings')
    .set(orgAuth(seller.token, 'don-anh'))
    .send({
      title: 'Tin giữ ảnh trên cloud',
      description: 'Mô tả đủ dài cho zod schema đi qua',
      price: 150000,
      categoryId,
      images: [url('ghim/keep-1'), url('ghim/keep-2')],
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành' },
    })
    .expect(201)

  await request(app)
    .patch('/api/v1/users/me')
    .set({ Authorization: `Bearer ${seller.token}` })
    .send({ avatar: url('ghim/keep-avatar') })
    .expect(200)
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

afterEach(() => vi.unstubAllGlobals())

/**
 * Giả lập Cloudinary: search trả danh sách cho trước, delete ghi lại những gì bị xoá.
 *
 * `endless` = mỗi trang đều kèm `next_cursor`, tức thư mục không bao giờ tự hết. Đó là cách duy
 * nhất dựng lại ca "kho lớn hơn một lượt quét" mà không cần 10.000 asset giả.
 */
function stubCloudinary(staleIds: string[], { endless = false }: { endless?: boolean } = {}) {
  const deleted: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const u = String(input)
      if (u.includes('/resources/search')) {
        return new Response(
          JSON.stringify({
            resources: staleIds.map((public_id) => ({ public_id })),
            ...(endless ? { next_cursor: 'con-tro-khong-bao-gio-het' } : {}),
          }),
          { status: 200 },
        )
      }
      if (u.includes('/resources/image/upload')) {
        const ids = [...new URL(u).searchParams.getAll('public_ids[]')]
        deleted.push(...ids)
        return new Response(
          JSON.stringify({ deleted: Object.fromEntries(ids.map((i) => [i, 'deleted'])) }),
          { status: 200 },
        )
      }
      throw new Error(`fetch không mong đợi: ${u}`)
    }),
  )
  return deleted
}

/**
 * Ghi lại biểu thức tìm kiếm job gửi lên — đó là chỗ DUY NHẤT phân biệt hai nhịp quét, nên cũng
 * là chỗ duy nhất kiểm được. Trả về `resources` rỗng vì ca này chỉ quan tâm câu hỏi được đặt ra,
 * không quan tâm câu trả lời.
 */
function captureExpressions() {
  const expressions: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.includes('/resources/search')) {
        expressions.push(JSON.parse(String(init?.body ?? '{}')).expression)
        return new Response(JSON.stringify({ resources: [] }), { status: 200 })
      }
      throw new Error(`fetch không mong đợi: ${u}`)
    }),
  )
  return expressions
}

describe('Job dọn ảnh mồ côi — hai nhịp quét', () => {
  it('nhịp LỨA kẹp thêm cận trên: chỉ nhìn ảnh vừa chạm tuổi tối thiểu', async () => {
    const exprs = captureExpressions()

    await uploadCleanupService.sweep(cfg, { mode: 'cohort' })

    expect(exprs).toHaveLength(1)
    expect(exprs[0]).toContain(`uploaded_at<${CLEANUP.MIN_AGE}`)
    expect(exprs[0]).toContain(`uploaded_at>${CLEANUP.COHORT_MAX_AGE}`)
  }, 60_000)

  /*
   * Vế còn lại của thiết kế, và là vế dễ bị "tối ưu" mất nhất.
   *
   * Nhịp toàn kho KHÔNG được kẹp cận trên. Kẹp vào thì job chỉ còn thấy rác mới, trong khi ảnh
   * bị gỡ lúc sửa tin, tin xoá mềm, avatar bị thay… đều thành rác HÀNG TUẦN SAU khi chúng đã đi
   * qua một lượt quét lứa sạch sẽ — và sẽ không lượt nào nhìn lại chúng nữa.
   */
  it('nhịp TOÀN KHO không kẹp cận trên: rác phát sinh muộn vẫn phải tới lượt', async () => {
    const exprs = captureExpressions()

    await uploadCleanupService.sweep(cfg, { mode: 'full' })

    expect(exprs[0]).toContain(`uploaded_at<${CLEANUP.MIN_AGE}`)
    expect(exprs[0]).not.toContain('uploaded_at>')
  }, 60_000)

  it('mặc định là TOÀN KHO — bản diễn tập phải thấy sự thật của cả kho, không chỉ lứa mới', async () => {
    const exprs = captureExpressions()

    await uploadCleanupService.sweep(cfg, { dryRun: true })

    expect(exprs[0]).not.toContain('uploaded_at>')
  }, 60_000)
})

describe('Job dọn ảnh mồ côi', () => {
  it('xoá đúng ảnh không ai tham chiếu, giữ nguyên ảnh của tin và avatar', async () => {
    const deleted = stubCloudinary([
      'ghim/keep-1',
      'ghim/keep-2',
      'ghim/keep-avatar',
      'ghim/orphan-1',
      'ghim/orphan-2',
    ])

    const result = await uploadCleanupService.sweep(cfg)

    expect(result).toEqual({
      scanned: 5,
      orphans: 2,
      deleted: 2,
      orphanIds: ['ghim/orphan-1', 'ghim/orphan-2'],
      scanComplete: true,
    })
    expect(deleted.sort()).toEqual(['ghim/orphan-1', 'ghim/orphan-2'])
  }, 60_000)

  it('kho sạch — không lệnh xoá nào được gọi', async () => {
    const deleted = stubCloudinary(['ghim/keep-1', 'ghim/keep-avatar'])

    const result = await uploadCleanupService.sweep(cfg)

    expect(result).toEqual({
      scanned: 2,
      orphans: 0,
      deleted: 0,
      orphanIds: [],
      scanComplete: true,
    })
    expect(deleted).toEqual([])
  }, 60_000)

  /*
   * Ca hỏng ĐÁNG SỢ NHẤT của cả tính năng, dựng lại bằng một cloud name lệch.
   *
   * `publicIdOf` khoá theo cloud name, nên env trỏ sai cloud là mọi URL đã lưu parse ra `null`,
   * tập "còn chủ" rỗng, và MỌI asset trên cloud thành mồ côi. Không có chốt thì lượt quét này
   * xoá sạch kho ảnh đang được dùng — không có đường khôi phục.
   */
  it('DB không tham chiếu tấm nào — DỪNG, không xoá gì', async () => {
    const deleted = stubCloudinary(['ghim/keep-1', 'ghim/keep-2', 'ghim/orphan-1'])

    const result = await uploadCleanupService.sweep({ ...cfg, cloudName: 'cloud-lech' })

    expect(result).toEqual({
      scanned: 3,
      orphans: 0,
      deleted: 0,
      orphanIds: [],
      scanComplete: true,
    })
    expect(deleted).toEqual([])
  }, 60_000)

  it('dry-run — vẫn tính ra mồ côi nhưng không gọi lệnh xoá nào', async () => {
    const deleted = stubCloudinary(['ghim/keep-1', 'ghim/keep-avatar', 'ghim/orphan-1'])

    const result = await uploadCleanupService.sweep(cfg, { dryRun: true })

    expect(result).toEqual({
      scanned: 3,
      orphans: 1,
      // `deleted: 0` đi cùng `orphanIds` KHÔNG rỗng là toàn bộ điểm của dry-run: script kiểm tra
      // đọc được danh sách sắp bị xoá mà chưa có tấm nào mất.
      deleted: 0,
      orphanIds: ['ghim/orphan-1'],
      scanComplete: true,
    })
    expect(deleted).toEqual([])
  }, 60_000)

  it('thiếu cấu hình CLOUDINARY_* — job tự tắt, không chạm mạng', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await uploadCleanupService.sweep(null)

    expect(result).toEqual({
      scanned: 0,
      orphans: 0,
      deleted: 0,
      orphanIds: [],
      scanComplete: true,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  /*
   * Ca này neo đúng lỗi vừa sửa: trước đây trần `MAX_PAGES` cắt lượt quét ở 10.000 asset và
   * lượt sau lại bắt đầu từ đầu thư mục, nên khi kho vượt ngưỡng đó thì ảnh đang dùng lấp kín
   * cửa sổ quét và job không bao giờ tới được tấm mồ côi nào nữa — hỏng mà vẫn chạy, vẫn log
   * "thành công", không ai thấy.
   *
   * `budgetMs: 0` dừng vòng lặp ngay sau trang đầu, còn `endless` giữ cho con trỏ không bao giờ
   * cạn — dựng lại ca "thư mục lớn hơn một lượt quét" mà không cần 10.000 asset giả.
   */
  /*
   * Cùng bản chất với ca hết-ngân-sách ngay dưới, nhưng nguyên nhân đến từ phía Cloudinary.
   *
   * Số lệnh gọi mỗi lượt = tổng asset ÷ 500, nên kho càng lớn càng dễ chạm trần hạn mức. Trước
   * đây một lượt 429 giữa chừng ném ra ngoài và vứt sạch phần đã quét — mất trắng cả ngày.
   */
  it('Cloudinary hết hạn mức giữa chừng — giữ phần đã quét, không mất cả lượt', async () => {
    const deleted: string[] = []
    let searchCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const u = String(input)
        if (u.includes('/resources/search')) {
          searchCalls += 1
          // Trang đầu có kết quả và còn con trỏ; lượt gọi tiếp theo ăn 429.
          if (searchCalls === 1) {
            return new Response(
              JSON.stringify({
                resources: [{ public_id: 'ghim/keep-1' }, { public_id: 'ghim/orphan-1' }],
                next_cursor: 'con-tro',
              }),
              { status: 200 },
            )
          }
          return new Response('Rate limit exceeded', { status: 429 })
        }
        if (u.includes('/resources/image/upload')) {
          const ids = [...new URL(u).searchParams.getAll('public_ids[]')]
          deleted.push(...ids)
          return new Response(
            JSON.stringify({ deleted: Object.fromEntries(ids.map((i) => [i, 'deleted'])) }),
            { status: 200 },
          )
        }
        throw new Error(`fetch không mong đợi: ${u}`)
      }),
    )

    const result = await uploadCleanupService.sweep(cfg)

    expect(result.scanComplete).toBe(false)
    expect(result.scanned).toBe(2)
    expect(deleted).toEqual(['ghim/orphan-1'])
  }, 60_000)

  /*
   * Hết hạn mức ở PHA XOÁ, không phải pha quét.
   *
   * 150 mồ côi = 2 lô (trần 100/lệnh). Lô đầu xoá được, lô sau ăn 429. Trước khi có chốt này,
   * lỗi đó ném ra ngoài và job coi như hỏng — dù một nửa công việc đã xong.
   */
  it('hết hạn mức giữa pha xoá — giữ lô đã xoá, dừng lại, không ném', async () => {
    const orphanIds = Array.from({ length: 150 }, (_, i) => `ghim/rac-${i}`)
    const deleted: string[] = []
    let deleteCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const u = String(input)
        if (u.includes('/resources/search')) {
          return new Response(
            JSON.stringify({ resources: orphanIds.map((public_id) => ({ public_id })) }),
            { status: 200 },
          )
        }
        if (u.includes('/resources/image/upload')) {
          deleteCalls += 1
          if (deleteCalls > 1) return new Response('Rate limit exceeded', { status: 429 })
          const ids = [...new URL(u).searchParams.getAll('public_ids[]')]
          deleted.push(...ids)
          return new Response(
            JSON.stringify({ deleted: Object.fromEntries(ids.map((i) => [i, 'deleted'])) }),
            { status: 200 },
          )
        }
        throw new Error(`fetch không mong đợi: ${u}`)
      }),
    )

    const result = await uploadCleanupService.sweep(cfg)

    expect(result.orphans).toBe(150)
    // Chỉ lô đầu xong; phần còn lại là mồ côi thật nên lượt sau sẽ gặp lại chúng.
    expect(result.deleted).toBe(100)
    expect(deleted).toHaveLength(100)
  }, 60_000)

  /*
   * Hai nhịp quét là hai job Agenda KHÁC TÊN, nên `concurrency: 1` của Agenda không chặn chúng
   * gặp nhau — lịch của chúng trùng mỗi 7 ngày. Cái đắt là bộ nhớ: mỗi lượt dựng một `Set` chứa
   * public_id của mọi ảnh trong DB.
   */
  it('đã có một lượt đang chạy — lượt thứ hai bỏ qua thay vì chạy song song', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        if (String(input).includes('/resources/search')) {
          await gate
          return new Response(JSON.stringify({ resources: [] }), { status: 200 })
        }
        throw new Error(`fetch không mong đợi: ${String(input)}`)
      }),
    )

    // Lượt đầu dừng ở lượt gọi mạng; `sweeping` đã bật trước khi nó nhường điều khiển.
    const first = uploadCleanupService.sweep(cfg, { mode: 'full' })
    const second = await uploadCleanupService.sweep(cfg, { mode: 'cohort' })

    expect(second.scanned).toBe(0)
    expect(second.scanComplete).toBe(false)

    release()
    await first
    // Chốt phải nhả sau khi lượt đầu xong, nếu không job chết vĩnh viễn từ lần thứ hai.
    const third = await uploadCleanupService.sweep(cfg, { mode: 'cohort' })
    expect(third.scanComplete).toBe(true)
  }, 60_000)

  it('lỗi KHÁC vẫn ném — sai xác thực không được lẫn vào một lượt quét "thành công một phần"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unauthorized', { status: 401 })),
    )

    await expect(uploadCleanupService.sweep(cfg)).rejects.toThrow(/401/)
  }, 60_000)

  it('hết ngân sách quét — vẫn dọn phần đã duyệt, và nói ra là chưa duyệt hết', async () => {
    const deleted = stubCloudinary(['ghim/keep-1', 'ghim/orphan-1'], { endless: true })

    const result = await uploadCleanupService.sweep(cfg, { budgetMs: 0 })

    expect(result.scanComplete).toBe(false)
    // Dừng sớm mất ĐỘ PHỦ, không mất tính đúng: mồ côi trong phần đã duyệt vẫn được dọn, và
    // ảnh còn chủ trong cùng trang đó vẫn nguyên.
    expect(result.scanned).toBe(2)
    expect(deleted).toEqual(['ghim/orphan-1'])
  }, 60_000)
})
