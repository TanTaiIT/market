import { locationService } from './location.service'
import { queryOf } from '../../middlewares/validate.middleware'
import { wardQuerySchema } from './location.schema'
import { catchAsync } from '../../common/utils/catchAsync'
import { success } from '../../common/utils/apiResponse'

export const locationController = {
  // GET /locations/provinces
  provinces: catchAsync(async (_req, res) => {
    success(res, { message: 'Provinces', data: locationService.listProvinces() })
  }),

  // GET /locations/wards?province=...
  wards: catchAsync(async (req, res) => {
    success(res, {
      message: 'Wards',
      data: locationService.listWards(queryOf(req, wardQuerySchema)),
    })
  }),
}
