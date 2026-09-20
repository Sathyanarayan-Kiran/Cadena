import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ImpactService, ServiceNotFoundError } from '../lineage/impact.service';
import { MAX_IMPACT_DEPTH } from '../lineage/impact.types';
import { ServiceRegistryService } from './service-registry.service';
import { InvalidServiceError, RegisterServiceDto } from './service-registry.types';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) {
    throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  }
  return orgId.trim();
}

@Controller('services')
export class ServiceRegistryController {
  private readonly registry = new ServiceRegistryService();
  private readonly impact = new ImpactService();

  @Post()
  async registerService(@Body() dto: RegisterServiceDto, @Headers('x-org-id') orgId?: string) {
    const tenant = requireOrg(orgId);
    try {
      return await this.registry.registerService(tenant, dto);
    } catch (error) {
      if (error instanceof InvalidServiceError) {
        throw new HttpException(
          { statusCode: 422, error: 'invalid_service', message: error.message },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw error;
    }
  }

  @Get()
  async listServices(@Headers('x-org-id') orgId?: string) {
    return this.registry.listServices(requireOrg(orgId));
  }

  @Get(':id')
  async getService(@Param('id') id: string, @Headers('x-org-id') orgId?: string) {
    const service = await this.registry.getServiceById(requireOrg(orgId), id);
    if (!service) throw new HttpException('Service not found', HttpStatus.NOT_FOUND);
    return service;
  }

  @Get(':id/work-items')
  async listAffectedWorkItems(@Param('id') id: string, @Headers('x-org-id') orgId?: string) {
    const tenant = requireOrg(orgId);
    const service = await this.registry.getServiceById(tenant, id);
    if (!service) throw new HttpException('Service not found', HttpStatus.NOT_FOUND);
    return {
      service,
      link_type: 'affects',
      work_items: await this.registry.listWorkItemsForService(tenant, id),
    };
  }

  /**
   * Records an `affects` edge by hand. Until now only the Epic 7 monitoring gateway could
   * create one, which left a manually raised Incident unable to declare what it affects.
   */
  @Post(':id/work-items')
  async linkAffectedWorkItem(
    @Param('id') id: string,
    @Body() body: { work_item_id?: string },
    @Headers('x-org-id') orgId?: string,
    @Headers('x-actor-id') actorId?: string,
  ) {
    const tenant = requireOrg(orgId);
    if (!body?.work_item_id?.trim()) {
      throw new HttpException(
        { statusCode: 422, error: 'invalid_service_link', message: 'work_item_id is required' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    try {
      return await this.registry.linkWorkItemToService(
        tenant,
        body.work_item_id.trim(),
        id,
        actorId || 'user-1',
      );
    } catch (error) {
      if (error instanceof InvalidServiceError) {
        throw new HttpException(
          { statusCode: 404, error: 'not_found', message: error.message },
          HttpStatus.NOT_FOUND,
        );
      }
      throw error;
    }
  }

  @Get(':id/impact')
  async getServiceImpact(
    @Param('id') id: string,
    @Headers('x-org-id') orgId?: string,
    @Query('depth') depth?: string,
    @Query('edge_types') edgeTypes?: string,
  ) {
    const tenant = requireOrg(orgId);
    if (depth !== undefined && !/^\d+$/.test(depth)) {
      throw new HttpException(
        {
          statusCode: 422,
          error: 'invalid_depth',
          message: `depth must be a whole number between 1 and ${MAX_IMPACT_DEPTH}`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    try {
      return await this.impact.getServiceImpact({
        orgId: tenant,
        serviceId: id,
        depth: depth !== undefined ? Number(depth) : undefined,
        edgeTypes: edgeTypes ? edgeTypes.split(',').map((value) => value.trim()).filter(Boolean) : undefined,
      });
    } catch (error) {
      if (error instanceof ServiceNotFoundError) {
        throw new HttpException('Service not found', HttpStatus.NOT_FOUND);
      }
      throw error;
    }
  }
}
