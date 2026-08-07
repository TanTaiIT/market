import { platformAdminService } from './platform-admin.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const platformAdminController = {
  // POST /platform-admin/auth/login
  login: catchAsync(async (req, res) => {
    const { admin, accessToken } = await platformAdminService.login(req.body)
    success(res, {
      message: 'Logged in successfully',
      data: {
        admin: {
          id: admin._id.toString(),
          email: admin.email,
          name: admin.name,
          role: admin.role,
        },
        accessToken,
      },
    })
  }),

  // POST /platform-admin/chains
  createChain: catchAsync(async (req, res) => {
    const chain = await platformAdminService.createChain(req.platformAdmin!.id, req.body)
    created(res, { message: 'Chain created', data: chain })
  }),

  // PATCH /platform-admin/organizations/:organizationId/chain
  assignChain: catchAsync(async (req, res) => {
    const org = await platformAdminService.assignChain(
      req.platformAdmin!.id,
      req.params.organizationId,
      req.body.chainId,
    )
    success(res, { message: 'Organization chain updated', data: org })
  }),

  // PATCH /platform-admin/organizations/:organizationId/status
  setOrganizationStatus: catchAsync(async (req, res) => {
    const org = await platformAdminService.setOrganizationStatus(
      req.platformAdmin!.id,
      req.params.organizationId,
      req.body.status,
    )
    success(res, { message: 'Organization status updated', data: org })
  }),
}
