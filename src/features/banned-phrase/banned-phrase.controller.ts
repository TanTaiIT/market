import { bannedPhraseService } from './banned-phrase.service'
import { catchAsync } from '../../common/utils/catchAsync'
import { success, created } from '../../common/utils/apiResponse'

export const bannedPhraseController = {
  // GET /banned-phrases
  list: catchAsync(async (_req, res) => {
    const phrases = await bannedPhraseService.list()
    success(res, { message: 'Banned phrases', data: phrases })
  }),

  // POST /banned-phrases
  create: catchAsync(async (req, res) => {
    const phrase = await bannedPhraseService.create(req.body, req.user!.id)
    created(res, { message: 'Banned phrase added', data: phrase })
  }),

  // DELETE /banned-phrases/:id
  remove: catchAsync(async (req, res) => {
    const phrase = await bannedPhraseService.remove(req.params.id, req.user!.id)
    success(res, { message: 'Banned phrase removed', data: phrase })
  }),
}
