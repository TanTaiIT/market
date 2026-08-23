import { Types } from 'mongoose'
import { walletService } from './wallet.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'

export const walletController = {
  // GET /wallet
  me: catchAsync(async (req, res) => {
    const balance = await walletService.balanceOf(new Types.ObjectId(req.user!.id))
    success(res, { message: 'Wallet', data: { balance, currency: 'xu' } })
  }),

  // GET /wallet/transactions
  history: catchAsync(async (req, res) => {
    const { items, meta } = await walletService.history(
      new Types.ObjectId(req.user!.id),
      req.query as { page?: number; limit?: number },
    )
    success(res, { message: 'Xu transactions', data: items, meta })
  }),

  // POST /wallet/:userId/adjust
  adjust: catchAsync(async (req, res) => {
    const tx = await walletService.adjust({
      userId: req.params.userId,
      actorId: req.user!.id,
      ...req.body,
    })
    success(res, { message: 'Wallet adjusted', data: tx })
  }),
}
