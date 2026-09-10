/* eslint-disable no-console */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import mongoose from 'mongoose'
import { env } from '../src/config/env'

/**
 * Đồng bộ index của MỌI model — bước deploy bắt buộc, không phải một migration một lần.
 *
 * Vì sao phải có: `config/database.ts` đặt `autoIndex: !env.isProd`, nên ở production Mongoose
 * KHÔNG tự tạo index. Chỗ duy nhất tạo là `syncIndexes()` trong các script migration — mà danh
 * sách model trong chúng viết tay, và nó đã bỏ sót 7 collection: `wallets`, `xutransactions`,
 * `favorites`, `invites`, `reports`, `bannedphrases`, `listingproducts`, `auditlogs`.
 *
 * Hậu quả không chỉ là chậm. Nhiều chốt NGHIỆP VỤ đang dựa vào unique index để hoạt động:
 * `invite.create`, `report.service`, `banned-phrase.service`, `listing-product.service` đều bắt
 * lỗi `11000` để nói "đã tồn tại". Không có index thì không có lỗi 11000, Mongo ghi bản trùng,
 * và nhánh xử lý đó âm thầm không bao giờ chạy. Nặng nhất: `xutransactions.idempotencyKey` —
 * thiếu unique thì idempotency của giao dịch Xu không tồn tại, một lần retry mạng là hai giao
 * dịch tiền. Còn `auditlogs` thiếu TTL thì phình vĩnh viễn.
 *
 * Script này KHÔNG có danh sách model viết tay — nó nạp mọi `*.model.ts` rồi hỏi chính Mongoose
 * đã đăng ký những gì. Thêm collection mới thì không ai phải nhớ cập nhật chỗ này, và đó là
 * toàn bộ lý do nó tồn tại thay vì thêm một `migrate-*.ts` nữa.
 *
 * MẶC ĐỊNH LÀ CHẠY THỬ. `syncIndexes` XOÁ index không còn khai trong schema — trên một
 * collection production đó là thao tác không hoàn tác được, nên phải xem trước rồi mới `--apply`.
 */
const APPLY = process.argv.includes('--apply')

const FEATURES_DIR = path.resolve(__dirname, '../src/features')

/** Nạp mọi file model để chúng tự đăng ký vào registry của Mongoose. */
async function loadAllModels(): Promise<void> {
  for (const feature of readdirSync(FEATURES_DIR, { withFileTypes: true })) {
    if (!feature.isDirectory()) continue
    const dir = path.join(FEATURES_DIR, feature.name)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.model.ts')) continue
      // `import()` động cần URL trên Windows — đường dẫn `D:\...` không phải specifier hợp lệ.
      await import(pathToFileURL(path.join(dir, file)).href)
    }
  }
}

async function run() {
  await loadAllModels()
  await mongoose.connect(env.MONGO_URI)

  const names = mongoose.modelNames().sort()
  console.log(`▶ db "${mongoose.connection.name}" · NODE_ENV=${env.NODE_ENV}`)
  console.log(
    `▶ ${names.length} model · chế độ: ${APPLY ? 'ÁP DỤNG' : 'chạy thử (thêm --apply để ghi)'}\n`,
  )

  let toCreate = 0
  let toDrop = 0

  for (const name of names) {
    const model = mongoose.model(name)
    /*
     * `diffIndexes` cho biết `syncIndexes` SẼ làm gì mà không đụng vào DB — đây là thứ biến
     * một lệnh không hoàn tác được thành một lệnh xem trước được.
     */
    const diff = await model.diffIndexes()
    if (diff.toCreate.length === 0 && diff.toDrop.length === 0) continue

    console.log(`${model.collection.collectionName}:`)
    for (const spec of diff.toCreate) console.log(`  + tạo  ${JSON.stringify(spec)}`)
    for (const idx of diff.toDrop) console.log(`  - XOÁ  ${idx}`)
    toCreate += diff.toCreate.length
    toDrop += diff.toDrop.length

    if (APPLY) {
      await model.syncIndexes()
      console.log(`  ✓ đã đồng bộ`)
    }
  }

  if (toCreate === 0 && toDrop === 0) {
    console.log('✅ Mọi index đã khớp schema, không có gì để làm.')
  } else if (APPLY) {
    console.log(`\n✅ Đã tạo ${toCreate} index, xoá ${toDrop} index.`)
  } else {
    console.log(
      `\n⚠️  Sẽ tạo ${toCreate} index và XOÁ ${toDrop} index. Chạy lại kèm --apply để thực hiện.`,
    )
  }

  await mongoose.disconnect()
  process.exit(0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
