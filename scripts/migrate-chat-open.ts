/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'
import { Conversation, Message } from '../src/features/chat/chat.model'

/**
 * Mở chat ra ngoài phạm vi nhóm: gỡ trục org khỏi `conversations` và `messages`.
 *
 * BẮT BUỘC chạy cùng lượt deploy có thay đổi này. Không phải vì dữ liệu cũ sai — hội thoại cũ
 * vẫn đọc được nguyên vẹn — mà vì INDEX: bộ cũ mở đầu bằng `organizationId`, trong khi truy vấn
 * mới ("hội thoại của tôi") lọc theo `participants.user` mà không kèm org. Không chạy thì mọi
 * lượt mở tab Tin nhắn là một lượt quét trọn bảng, và nó chỉ lộ ra khi dữ liệu đã đủ lớn.
 *
 * Idempotent: `syncIndexes` so bộ index thật với bộ khai trong schema rồi bù trừ, chạy lại lần
 * hai không đụng gì.
 *
 * Chạy: npm run migrate:chat-open
 */
async function migrate() {
  await mongoose.connect(env.MONGO_URI)
  console.log(`▶ db "${mongoose.connection.name}" · NODE_ENV=${env.NODE_ENV}`)

  /*
   * `messages.organizationId` biến mất khỏi schema — nó là bản sao của org trên hội thoại cha
   * và không còn ai đọc. Gỡ khỏi document luôn thay vì để nằm im: một field không khai trong
   * schema thì Mongoose không đọc cũng không ghi, nên nó thành dữ liệu ma mà lần debug sau sẽ
   * có người tin theo.
   *
   * Chạy TRƯỚC `syncIndexes` để index cũ (đang dùng chính field này) còn đỡ cho lượt quét.
   */
  const cleaned = await Message.collection.updateMany(
    { organizationId: { $exists: true } },
    { $unset: { organizationId: '' } },
  )
  console.log(`Đã gỡ organizationId khỏi ${cleaned.modifiedCount} tin nhắn.`)

  for (const model of [Conversation, Message]) {
    const before = (await model.collection.indexes()).map((i) => i.name)
    const dropped = await model.syncIndexes()
    const after = (await model.collection.indexes()).map((i) => i.name)
    console.log(`\n${model.collection.collectionName}:`)
    console.log(`  trước : ${before.join(', ')}`)
    console.log(`  sau   : ${after.join(', ')}`)
    if (dropped.length > 0) console.log(`  đã gỡ : ${dropped.join(', ')}`)
  }

  /*
   * `conversations.organizationId` thì GIỮ LẠI — nó vẫn nằm trong schema, chỉ đổi vai từ khoá
   * phân vùng thành thông tin attribution ("hội thoại này đến từ bảng tin của nhóm nào").
   * Hội thoại tạo sau, về tin công khai, sẽ mang `null`.
   */
  const withOrg = await Conversation.countDocuments({ organizationId: { $ne: null } })
  const total = await Conversation.countDocuments()
  console.log(
    `\nHội thoại: ${total} tổng, ${withOrg} gắn với một nhóm (giữ nguyên để attribution).`,
  )

  await mongoose.disconnect()
}

migrate().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
