import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { InvalidWorkflowDefinitionError, WorkflowService } from './workflow.service';
import { WorkflowDefinition } from './workflow.types';

@Controller('workflows')
export class WorkflowController {
  private service = new WorkflowService();

  @Post('definitions')
  async publishWorkflow(@Body() def: WorkflowDefinition) {
    try {
      return await this.service.publishWorkflow(def);
    } catch (err) {
      if (err instanceof InvalidWorkflowDefinitionError) {
        throw new HttpException(
          {
            statusCode: 400,
            error: 'Bad Request',
            message: err.message,
            errors: err.errors,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw err;
    }
  }

  @Get('definitions/:type')
  async getWorkflow(
    @Param('type') type: string,
    @Query('version') version?: string,
  ) {
    const v = version ? parseInt(version, 10) : undefined;
    const def = await this.service.getWorkflowDefinition(type, v);
    if (!def) {
      throw new HttpException('Workflow definition not found', HttpStatus.NOT_FOUND);
    }
    return def;
  }
}
