import { inviteService } from './invite.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { created, success } from '../../common/utils/apiResponse'

export const inviteController = {
  // POST /invites
  create: catchAsync(async (req, res) => {
    const data = await inviteService.create(req.body, req.user!.id)
    created(res, { message: 'Invite created', data })
  }),

  // GET /invites
  list: catchAsync(async (req, res) => {
    const { items, meta } = await inviteService.list(req.query as never)
    success(res, { message: 'Invites', data: items, meta })
  }),

  // GET /invites/mine
  mine: catchAsync(async (req, res) => {
    const data = await inviteService.listMine(req.user!.id)
    success(res, { message: 'My invites', data })
  }),

  // DELETE /invites/:id
  revoke: catchAsync(async (req, res) => {
    const data = await inviteService.revoke(req.params.id)
    success(res, { message: 'Invite revoked', data })
  }),

  // GET /invites/token/:token
  preview: catchAsync(async (req, res) => {
    const data = await inviteService.preview(req.params.token)
    success(res, { message: 'Invite', data })
  }),

  // POST /invites/token/:token/accept
  accept: catchAsync(async (req, res) => {
    const data = await inviteService.accept(req.params.token, req.user!.id)
    success(res, { message: 'Joined organization', data })
  }),
}
