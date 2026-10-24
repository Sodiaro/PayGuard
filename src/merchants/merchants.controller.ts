import { Controller, Get, NotFoundException } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentMerchant } from '../auth/auth.decorators.js';
import type { AuthenticatedMerchant } from '../auth/authenticated-merchant.js';
import { ErrorResponse } from '../common/http/error-response.js';
import { MerchantResponse } from './merchant.responses.js';
import { MerchantsService } from './merchants.service.js';

@ApiTags('Merchants')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorResponse })
@Controller('merchants')
export class MerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  @Get('me')
  @ApiOperation({ summary: 'The merchant that owns the presented API key' })
  @ApiOkResponse({ type: MerchantResponse })
  async me(
    @CurrentMerchant() auth: AuthenticatedMerchant,
  ): Promise<MerchantResponse> {
    const merchant = await this.merchants.findById(auth.merchantId);
    if (!merchant) throw new NotFoundException('Merchant not found');
    return MerchantResponse.from(merchant);
  }
}
