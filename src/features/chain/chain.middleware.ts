import { Types } from 'mongoose'
import { catchAsync } from '../../common/utils/catchAsync'
import { ForbiddenError } from '../../common/errors'
import { runWithTenant } from '../../common/tenant/tenantContext'
import { chainRepository } from './chain.repository'
import { organizationRepository } from '../organization/organization.repository'

/**
 * Quyền chain KHÔNG đến từ `role` (role là quyền trong org) mà từ `Chain.ownerId` —
 * chain owner vẫn là một User bình thường thuộc một org bất kỳ (quyết định #11).
 *
 * Mở lại scope với toàn bộ org của chain: từ đây trở đi repository dùng lại nguyên xi,
 * không service nào cần nhánh `if (isChainOwner)`.
 */
export const requireChainOwner = catchAsync(async (req, _res, next) => {
  const chain = await chainRepository.findActiveById(req.params.chainId)
  if (!chain || chain.ownerId.toString() !== req.user!.id) {
    throw new ForbiddenError('Không phải chủ chain')
  }

  const chainOrgIds = await organizationRepository.activeIdsByChain(chain._id)
  // ownOrgId vẫn là org của chính chain owner: chain là read-only, mọi thao tác ghi
  // (kể cả của chain owner) vẫn phải rơi về org của họ.
  const ownOrgId = new Types.ObjectId(req.user!.organizationId)

  runWithTenant({ ownOrgId, chainOrgIds }, next)
})
