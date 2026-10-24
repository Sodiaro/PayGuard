import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentMerchant } from '../auth/auth.decorators.js';
import type { AuthenticatedMerchant } from '../auth/authenticated-merchant.js';
import { ErrorResponse } from '../common/http/error-response.js';
import { ApiKeysService } from './api-keys.service.js';
import { ApiKeyResponse } from './merchant.responses.js';

@ApiTags('API keys')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorResponse })
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @ApiOperation({ summary: "List the authenticated merchant's API keys" })
  @ApiOkResponse({ type: [ApiKeyResponse] })
  async list(
    @CurrentMerchant() auth: AuthenticatedMerchant,
  ): Promise<ApiKeyResponse[]> {
    const keys = await this.apiKeys.listForMerchant(auth.merchantId);
    return keys.map((key) => ApiKeyResponse.from(key));
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get an API key owned by the authenticated merchant',
  })
  @ApiOkResponse({ type: ApiKeyResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  async get(
    @CurrentMerchant() auth: AuthenticatedMerchant,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiKeyResponse> {
    const key = await this.apiKeys.findForMerchant(auth.merchantId, id);
    if (!key) throw new NotFoundException('API key not found');
    return ApiKeyResponse.from(key);
  }
}
