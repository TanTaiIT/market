/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
import { Organization } from '../src/features/organization/organization.model'

/**
 * Mở cửa nhận tin người ngoài cho các nhóm ĐÃ TỒN TẠI.
 *
 * Đổi `default` trong schema chỉ áp cho nhóm tạo MỚI — nhóm cũ đã có `allowOutsiderPosts:
 * false` nằm sẵn trong DB, nên không chạy script này thì nghiệp vụ mới chỉ đúng với nhóm lập
 * sau hôm nay, và chủ nhóm cũ không hiểu vì sao nhóm mình vẫn chặn.
 *
 * Chỉ đụng bản ghi còn `false`. Nhóm nào đã tự tắt lại SAU khi chạy script sẽ bị bật lại nếu
 * chạy lần hai — nên chạy MỘT lần lúc đổi chính sách, đừng đưa vào quy trình deploy.
 */
async function migrate() {
  await mongoose.connect(env.MONGO_URI)

  const before = await Organization.countDocuments({ allowOutsiderPosts: false }).exec()
  const res = await Organization.updateMany(
    { allowOutsiderPosts: false },
    { $set: { allowOutsiderPosts: true } },
  ).exec()

  const total = await Organization.countDocuments().exec()
  console.log(`Đã mở cửa cho ${res.modifiedCount}/${before} nhóm đang đóng. Tổng ${total} nhóm.`)
  console.log(
    'Nhóm kín muốn đóng lại: PATCH /organizations/current { "allowOutsiderPosts": false }',
  )

  await mongoose.disconnect()
  process.exit(0)
}

migrate().catch((err) => {
  console.error(err)
  process.exit(1)
})
