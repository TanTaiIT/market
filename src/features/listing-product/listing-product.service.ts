import { Types } from 'mongoose'
import { listingProductRepository } from './listing-product.repository'
import { CreateListingProductInput, UpdateListingProductInput } from './listing-product.schema'
import { productRuleErrors } from '../listing/listing.pricing'
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors'
import { logger } from '../../config/logger'

/** Giá từ master chỉ mang `amount` — server đóng đinh đơn vị, không tin client chọn tiền tệ. */
const toPrice = (price: { amount: number } | null | undefined) =>
  price === undefined
    ? undefined
    : price === null
      ? null
      : { amount: price.amount, currency: 'xu' as const }

export const listingProductService = {
  /** Màn quản trị của master — đủ mọi gói, kể cả nháp. */
  listForAdmin() {
    return listingProductRepository.listAll()
  },

  /** Catalog công khai — chỉ gói đang mở bán. */
  listEnabled() {
    return listingProductRepository.listEnabled()
  },

  async create(input: CreateListingProductInput, actorId: string) {
    const draft = {
      code: input.code,
      name: input.name,
      description: input.description ?? '',
      effect: input.effect,
      durationDays: input.durationDays ?? null,
      cooldownHours: input.cooldownHours ?? null,
      price: toPrice(input.price) ?? null,
      enabled: input.enabled ?? false,
      order: input.order ?? 0,
    }
    assertConsistent(draft)

    try {
      const product = await listingProductRepository.create({
        ...draft,
        createdBy: new Types.ObjectId(actorId),
      })
      logger.info('listing product created', { actorId, code: product.code })
      return product
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 11000) {
        throw new ConflictError('Đã có gói mang code này')
      }
      throw err
    }
  },

  /**
   * Luật xuyên field kiểm trên BẢN GHÉP (bản lưu + patch) — PATCH gửi thiếu field là chuyện
   * bình thường, zod một mình không đủ dữ kiện để phán "mở bán mà chưa có giá".
   */
  async update(id: string, input: UpdateListingProductInput, actorId: string) {
    const existing = await listingProductRepository.findById(id)
    if (!existing) throw new NotFoundError('Không tìm thấy gói tin này')

    const price = toPrice(input.price)
    assertConsistent({
      effect: input.effect ?? existing.effect,
      durationDays: input.durationDays !== undefined ? input.durationDays : existing.durationDays,
      price: price !== undefined ? price : existing.price,
      enabled: input.enabled ?? existing.enabled,
    })

    // `price` ghi đè SAU spread vì hình từ zod (`{amount}`) khác hình lưu trữ
    // (`{amount, currency}`). Client không gửi thì nó là `undefined` và Mongoose bỏ hẳn key —
    // KHÔNG ghi lại giá cũ: hai master sửa cùng lúc thì người đổi `name` sẽ đạp mất giá mà
    // người kia vừa đặt.
    const updated = await listingProductRepository.updateById(id, { ...input, price })
    logger.info('listing product updated', { actorId, code: existing.code })
    return updated!
  },

  /**
   * Xoá cứng — dành cho gói tạo nhầm/chưa từng bán. Gói đã chạy một thời gian thì NGỪNG BÁN
   * (enabled: false) là đường đúng: giữ code cho sổ cái tương lai còn chỗ tham chiếu.
   */
  async remove(id: string, actorId: string) {
    const product = await listingProductRepository.deleteById(id)
    if (!product) throw new NotFoundError('Không tìm thấy gói tin này')
    logger.info('listing product removed', { actorId, code: product.code })
    return product
  },
}

function assertConsistent(def: Parameters<typeof productRuleErrors>[0]): void {
  const errors = productRuleErrors(def)
  if (errors.length > 0) throw new BadRequestError(errors.join(' · '))
}
