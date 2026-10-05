/* eslint-disable no-console */
import mongoose from 'mongoose'

interface MigrationRow {
  name: string
  startedAt: Date
  appliedAt: Date | null
}

/**
 * Sổ migration `_migrations` (audit 7.2): mỗi tên chạy ĐÚNG MỘT LẦN trên một database. Chạy lại là
 * bỏ qua, không phải làm lại — migration gỡ index/xoá field vốn không phải thứ chạy hai lần được.
 *
 * Ghi dấu `startedAt` TRƯỚC khi chạy; hỏng giữa chừng thì xoá dấu để lượt sau làm lại từ đầu (các
 * script đều được viết idempotent, xem docblock từng file). Chỉ khi xong mới đóng `appliedAt`.
 */
export async function runMigrationOnce(
  name: string,
  fn: () => Promise<void>,
): Promise<'applied' | 'skipped'> {
  const ledger = mongoose.connection.db!.collection<MigrationRow>('_migrations')
  await ledger.createIndex({ name: 1 }, { unique: true })

  const existing = await ledger.findOne({ name })
  if (existing?.appliedAt) {
    console.log(`↷ ${name}: đã chạy lúc ${existing.appliedAt.toISOString()} — bỏ qua`)
    return 'skipped'
  }

  await ledger.updateOne(
    { name },
    { $set: { startedAt: new Date(), appliedAt: null } },
    { upsert: true },
  )
  try {
    await fn()
  } catch (err) {
    await ledger.deleteOne({ name })
    throw err
  }
  await ledger.updateOne({ name }, { $set: { appliedAt: new Date() } })
  console.log(`✔ ${name}: đã ghi sổ _migrations`)
  return 'applied'
}
