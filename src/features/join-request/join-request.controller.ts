import { joinRequestService } from './join-request.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'
import { requireOwnOrgId } from '../../common/tenant/tenantContext'

export const joinRequestController = {
  // POST /join-requests
  create: catchAsync(async (req, res) => {
    const data = await joinRequestService.create(req.user!.id, req.body)
    created(res, { message: 'Đã gửi đơn tham gia', data })
  }),

  // GET /join-requests/mine
  mine: catchAsync(async (req, res) => {
    const data = await joinRequestService.listMine(req.user!.id)
    success(res, { message: 'Đơn của tôi', data })
  }),

  // DELETE /join-requests/:id
  cancel: catchAsync(async (req, res) => {
    const data = await joinRequestService.cancel(req.user!.id, req.params.id)
    success(res, { message: 'Đã rút đơn', data })
  }),

  // GET /join-requests
  list: catchAsync(async (req, res) => {
    const orgId = requireOwnOrgId('joinRequest.list')
    const data = await joinRequestService.listForOrganization(
      orgId,
      req.query.status as string | undefined,
    )
    success(res, { message: 'Hàng đợi đơn tham gia', data })
  }),

  // PATCH /join-requests/:id/approve
  approve: catchAsync(async (req, res) => {
    const orgId = requireOwnOrgId('joinRequest.approve')
    const data = await joinRequestService.approve(
      req.user!.id,
      orgId,
      req.params.id,
      req.body.unitId,
    )
    success(res, { message: 'Đã duyệt đơn', data })
  }),

  // PATCH /join-requests/:id/reject
  reject: catchAsync(async (req, res) => {
    const orgId = requireOwnOrgId('joinRequest.reject')
    const data = await joinRequestService.reject(
      req.user!.id,
      orgId,
      req.params.id,
      req.body.reason,
    )
    success(res, { message: 'Đã từ chối đơn', data })
  }),

  // POST /join-requests/bulk-approve
  bulkApprove: catchAsync(async (req, res) => {
    const orgId = requireOwnOrgId('joinRequest.bulkApprove')
    const data = await joinRequestService.bulkApprove(req.user!.id, orgId, req.body.items)
    success(res, { message: 'Đã duyệt hàng loạt', data })
  }),
}
