import { Types } from 'mongoose'
import { IListingProduct, ListingProduct } from './listing-product.model'

export const listingProductRepository = {
  /** Bản đầy đủ cho màn quản trị — kể cả gói nháp/ngừng bán. */
  listAll() {
    return ListingProduct.find().sort({ order: 1, createdAt: 1 }).exec()
  },

  /** Catalog công khai = những gói ĐANG BÁN — người mua không cần thấy bản nháp của master. */
  listEnabled() {
    return ListingProduct.find({ enabled: true }).sort({ order: 1, createdAt: 1 }).exec()
  },

  findById(id: string) {
    return ListingProduct.findById(id).exec()
  },

  create(data: Partial<IListingProduct> & { createdBy: Types.ObjectId }) {
    return ListingProduct.create(data)
  },

  updateById(id: string, update: Partial<IListingProduct>) {
    return ListingProduct.findByIdAndUpdate(id, update, { new: true, runValidators: true }).exec()
  },

  deleteById(id: string) {
    return ListingProduct.findByIdAndDelete(id).exec()
  },
}
