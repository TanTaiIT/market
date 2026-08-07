import { IOrganizationDocument } from './organization.model'
import { OrganizationSummaryDto } from './organization.schema'

export function toOrganizationDto(org: IOrganizationDocument): OrganizationSummaryDto {
  return {
    id: org._id.toString(),
    name: org.name,
    slug: org.slug,
    chainId: org.chainId ? org.chainId.toString() : null,
    status: org.status,
  }
}
