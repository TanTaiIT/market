import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Application } from 'express'
import {
  TestUser,
  createCategory,
  createTestApp,
  makeMaster,
  publishListing,
  registerUser,
  startTestDb,
} from '../helpers/fixtures'

let app: Application
let mongod: MongoMemoryReplSet
let master: TestUser
let seller: TestUser
let categoryId: string

/**
 * KHOÁ ĐỊNH TUYẾN ĐÓNG BĂNG SAU KHI ĐĂNG.
 *
 * Ô duyệt của một tin lên sàn là cặp (danh mục × `provinceCode` × `wardCode`). Hai field sau là
 * field RIÊNG ở cấp cao nhất, KHÁC với `location.province`/`location.ward` mà giao diện hiển
 * thị và bộ lọc tìm kiếm đọc — `resolveProvinceCode` chỉ dựng chúng một lần lúc tạo.
 *
 * Hệ quả nếu để `location` sửa được: tin đăng ở tỉnh A, duyệt xong, sửa sang tỉnh B thì hiện ra
 * ở B trong khi quyền duyệt vẫn nằm ở A — và `touchesReviewedContent` không soi location nên
 * tin còn chẳng bị xếp hàng lại. Bộ test này khoá đúng đường đó.
 */
beforeAll(async () => {
  mongod = await startTestDb()
  app = await createTestApp()
  master = await makeMaster(app)
  seller = await registerUser(app, 'seller@route-lock.local', 'Người bán')
  categoryId = await createCategory('Đồ dùng', 'do-dung')
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

const bearer = (who: TestUser) => ({ Authorization: `Bearer ${who.token}` })

/** Tin LÊN SÀN — bậc duy nhất mà ô (danh mục × tỉnh × phường) có nghĩa. */
async function postListing(title: string, who: TestUser = seller) {
  const res = await request(app)
    .post('/api/v1/listings')
    .set(bearer(who))
    .send({
      title,
      description: 'Mô tả đủ dài cho zod schema đi qua bình thường',
      price: 150000,
      categoryId,
      images: ['https://res.cloudinary.com/demo/image/upload/v1/sample.jpg'],
      reach: 'marketplace',
      location: { province: 'Hồ Chí Minh', ward: 'Phường Bến Thành', address: '12 Lê Lợi' },
    })
    .expect(201)
  return res.body.data._id as string
}

/** Đọc thẳng document: `provinceCode`/`wardCode` không lộ ra DTO công khai. */
async function routingCellOf(id: string) {
  const { Listing } = await import('../../src/features/listing/listing.model')
  const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
  const doc = await runUnscoped('test: đọc khoá định tuyến', () =>
    Listing.findById(id).lean().exec(),
  )
  return {
    provinceCode: doc!.provinceCode,
    wardCode: doc!.wardCode,
    locationProvince: doc!.location?.province ?? null,
    locationWard: doc!.location?.ward ?? null,
    address: doc!.location?.address ?? null,
    status: doc!.status,
  }
}

const patch = (id: string, body: Record<string, unknown>, who: TestUser = seller) =>
  request(app).patch(`/api/v1/listings/${id}`).set(bearer(who)).send(body)

describe('Khoá định tuyến đóng băng sau khi đăng', () => {
  it('lúc tạo, ô duyệt dựng từ location và hai bên khớp nhau', async () => {
    const id = await postListing('Bàn gỗ thông còn mới')
    const cell = await routingCellOf(id)

    expect(cell.provinceCode).toBe('Hồ Chí Minh')
    expect(cell.wardCode).toBe('Phường Bến Thành')
    expect(cell.locationProvince).toBe('Hồ Chí Minh')
  })

  it('sửa tin KHÔNG gửi được tỉnh/phường nữa — 400, không phải bỏ qua lặng lẽ', async () => {
    const id = await postListing('Ghế nhựa cũ cho ai cần')

    const res = await patch(id, {
      location: { province: 'Hà Nội', ward: 'Phường Cửa Nam', address: '1 Tràng Tiền' },
    })

    // `.strict()` của zod: field lạ là 400. Bỏ qua lặng lẽ sẽ tệ hơn — người bán tưởng đã đổi
    // được khu vực, còn tin thì vẫn nằm ở tỉnh cũ.
    expect(res.status).toBe(400)
  })

  it('sửa được SỐ NHÀ, và tỉnh/phường đứng nguyên chứ không bị xoá', async () => {
    const id = await postListing('Tủ sách gỗ sồi')

    await patch(id, { location: { address: '99 Nguyễn Huệ' } }).expect(200)

    const cell = await routingCellOf(id)
    expect(cell.address).toBe('99 Nguyễn Huệ')
    // Chốt thật của ca này: gán lại cả `location` sẽ xoá hai field dưới, và tin rơi khỏi mọi
    // bộ lọc tỉnh mà không ai thấy.
    expect(cell.locationProvince).toBe('Hồ Chí Minh')
    expect(cell.locationWard).toBe('Phường Bến Thành')
    expect(cell.provinceCode).toBe('Hồ Chí Minh')
    expect(cell.wardCode).toBe('Phường Bến Thành')
  })

  it('tin ĐÃ DUYỆT sửa số nhà thì không bị đá về hàng đợi — số nhà không phải nội dung đã duyệt', async () => {
    const id = await postListing('Xe đạp thể thao')
    await publishListing(id)

    await patch(id, { location: { address: '5 Hai Bà Trưng' } }).expect(200)

    expect((await routingCellOf(id)).status).toBe('active')
  })

  /*
   * Danh mục CỐ Ý không bị khoá, và đây là chỗ nói rõ vì sao nó vẫn an toàn.
   *
   * Khác tỉnh/phường ở đúng một điểm: `categoryId` nằm trong `touchesReviewedContent`, nên đổi
   * nó là nội dung đã duyệt bị chạm → tin xếp hàng lại, và ô mới tính từ `category` đang lưu,
   * tức manager danh mục MỚI là người nhận. Không có drift nào để bịt.
   *
   * Người bán bậc thấp để thấy được nhánh xếp-hàng-lại: tài khoản mới bắt đầu ở bậc TRẦN
   * (`trustRepository.levelOf` — "không bản ghi = tài khoản mới = bậc trần"), nên họ tự đăng
   * được và `update` cố tình bỏ qua việc giữ tin lại. Điều đó cũng đúng chứ không phải lỗ: họ
   * xoá tin rồi đăng thẳng vào danh mục mới thì kết quả y hệt.
   */
  it('đổi DANH MỤC vẫn được, và tin quay lại hàng đợi của danh mục MỚI', async () => {
    const { setTrustLevel } = await import('../helpers/fixtures')
    const strict = await registerUser(app, 'strict@route-lock.local', 'Người bán bậc thấp')
    await setTrustLevel(strict.id, 1)

    const other = await createCategory('Xe cộ', 'xe-co')
    const id = await postListing('Nồi cơm điện còn bảo hành', strict)
    await publishListing(id)

    await patch(id, { categoryId: other }, strict).expect(200)

    const cell = await routingCellOf(id)
    expect(cell.status).toBe('pending')
    // Ô đã chuyển thật, không chỉ đổi trạng thái: đây mới là thứ quyết định ai duyệt.
    const { Listing } = await import('../../src/features/listing/listing.model')
    const { runUnscoped } = await import('../../src/common/tenant/tenantContext')
    const doc = await runUnscoped('test: đọc danh mục sau khi đổi', () =>
      Listing.findById(id).lean().exec(),
    )
    expect(doc!.category.toString()).toBe(other)
  })
})

describe('Master chuyển ô — phường phải theo tỉnh', () => {
  it('đổi tỉnh thì phường cũ bị gỡ, không để lại ô không tồn tại', async () => {
    const id = await postListing('Máy khoan cầm tay')

    await request(app)
      .patch(`/api/v1/moderation/listings/${id}/route`)
      .set(bearer(master))
      .send({ provinceCode: 'Hà Nội' })
      .expect(200)

    const cell = await routingCellOf(id)
    expect(cell.provinceCode).toBe('Hà Nội')
    // Giữ 'Phường Bến Thành' của HCM lại dưới Hà Nội là một ô không ai phủ: manager phường của
    // Hà Nội không giữ phường đó, nên tin tụt lên cấp tỉnh mà không ai biết vì sao.
    expect(cell.wardCode).toBeNull()
    expect(cell.status).toBe('pending')
  })

  it('không đổi tỉnh thì phường giữ nguyên', async () => {
    const other = await createCategory('Điện tử', 'dien-tu')
    const id = await postListing('Loa bluetooth')

    await request(app)
      .patch(`/api/v1/moderation/listings/${id}/route`)
      .set(bearer(master))
      .send({ categoryId: other })
      .expect(200)

    expect((await routingCellOf(id)).wardCode).toBe('Phường Bến Thành')
  })
})
