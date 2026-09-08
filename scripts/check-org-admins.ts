/* eslint-disable no-console */
import mongoose from 'mongoose'
import { env } from '../src/config/env'
import { Organization } from '../src/features/organization/organization.model'
import { usableOrgAdmins } from '../src/features/role-grant/role-grant.service'
import { runUnscoped } from '../src/common/tenant/tenantContext'
import { TENANT_STATUS } from '../src/common/constants'

/**
 * Soi dữ liệu ĐANG CÓ: tổ chức nào đang hoạt động mà không còn quản trị dùng được.
 *
 * Ba chốt runtime (`roleGrantService.revoke`, `membershipService.remove`,
 * `userService.deleteAccount`) chỉ chặn từ nay trở đi — chúng không sửa được các org đã mất
 * quản trị trước khi có chốt. Script này tìm ra chúng để master đi trao quyền lại.
 *
 * CHỈ ĐỌC, cố ý. Cách sửa duy nhất là trao quyền cho một người thật
 * (`POST /organizations/:id/admin`) — không có lựa chọn tự động nào đúng, vì chọn ai làm quản
 * trị một tổ chức không phải quyết định mà một script được phép đưa ra.
 */
async function check() {
  await mongoose.connect(env.MONGO_URI)
  console.log(`▶ db "${mongoose.connection.name}" · NODE_ENV=${env.NODE_ENV}`)

  // Cả `suspended`: org bị tạm dừng vẫn mở lại được, mà mở lại một org không có quản trị là
  // đúng cái trạng thái bất biến này cấm.
  const orgs = await runUnscoped('check: soi quản trị của mọi org', () =>
    Organization.find({ status: { $in: [TENANT_STATUS.ACTIVE, TENANT_STATUS.SUSPENDED] } })
      .select('name slug status')
      .lean()
      .exec(),
  )

  const orphaned: typeof orgs = []
  for (const org of orgs) {
    if ((await usableOrgAdmins(org._id)) === 0) orphaned.push(org)
  }

  if (orphaned.length === 0) {
    console.log(`✅ ${orgs.length} tổ chức, tất cả đều còn quản trị dùng được.`)
  } else {
    console.log(`❌ ${orphaned.length}/${orgs.length} tổ chức KHÔNG còn quản trị dùng được:`)
    for (const org of orphaned) {
      console.log(`   · ${org.name} (${org.slug}) — status=${org.status}, id=${org._id}`)
    }
    console.log('\nSửa: POST /organizations/<id>/admin { email } với tài khoản sẽ phụ trách.')
  }

  await mongoose.disconnect()
  process.exit(orphaned.length === 0 ? 0 : 1)
}

check().catch((err) => {
  console.error(err)
  process.exit(1)
})
