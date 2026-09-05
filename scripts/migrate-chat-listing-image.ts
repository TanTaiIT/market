/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { runUnscoped } from '../src/common/tenant/tenantContext'
import { Conversation } from '../src/features/chat/chat.model'
import { Listing } from '../src/features/listing/listing.model'

/**
 * Backfill `conversations.listingImage` — ảnh tin, snapshot mà hội thoại cũ chưa có.
 *
 * Mặc định `''` trong schema đã đủ để hội thoại cũ KHÔNG vỡ (client rơi về dải màu suy từ id),
 * nên đây không phải migration bắt buộc để deploy. Nhưng không chạy thì mọi hội thoại đã có
 * vĩnh viễn không có ảnh: `listingImage` chỉ được ghi lúc MỞ hội thoại, và một hội thoại chỉ
 * mở đúng một lần.
 *
 * Idempotent — chỉ đụng bản ghi còn thiếu ảnh, chạy lại lần hai không sửa gì.
 *
 * Chạy: npm run migrate:chat-listing-image
 */
async function migrate() {
  await mongoose.connect(env.MONGO_URI)
  console.log(`▶ db "${mongoose.connection.name}" · NODE_ENV=${env.NODE_ENV}`)

  await runUnscoped('backfill ảnh tin cho hội thoại cũ', async () => {
    const pending = await Conversation.find({
      $or: [{ listingImage: { $exists: false } }, { listingImage: '' }],
    })
      .select('listingId')
      .lean()

    if (pending.length === 0) {
      console.log('Không có hội thoại nào thiếu ảnh.')
      return
    }

    /*
     * Đọc ảnh của MỌI tin liên quan trong MỘT lượt, không hỏi từng hội thoại một: nhiều người
     * mua cùng nhắn về một tin là chuyện thường, nên số tin luôn ít hơn số hội thoại.
     *
     * `withDeleted` vì tin đã gỡ vẫn phải trả được ảnh — chính là ca mà snapshot sinh ra để
     * phục vụ. Không có nó thì đúng những hội thoại cần backfill nhất lại bị bỏ qua.
     */
    const listingIds = [...new Set(pending.map((c) => c.listingId.toString()))]
    const listings = await Listing.find({ _id: { $in: listingIds } })
      .setOptions({ withDeleted: true })
      .select('images')
      .lean()

    const imageOf = new Map(listings.map((l) => [l._id.toString(), l.images?.[0] ?? '']))

    let filled = 0
    let noImage = 0
    let gone = 0
    for (const conversation of pending) {
      const key = conversation.listingId.toString()
      if (!imageOf.has(key)) {
        gone += 1
        continue
      }
      const image = imageOf.get(key)!
      if (!image) {
        noImage += 1
        continue
      }
      await Conversation.updateOne({ _id: conversation._id }, { $set: { listingImage: image } })
      filled += 1
    }

    console.log(`Đã điền ảnh cho ${filled}/${pending.length} hội thoại.`)
    if (noImage > 0) console.log(`  ${noImage} hội thoại: tin không có ảnh nào — để trống.`)
    if (gone > 0) console.log(`  ${gone} hội thoại: tin đã bị xoá hẳn — để trống.`)
  })

  await mongoose.disconnect()
}

migrate().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
