import { Body, Controller, Headers, Inject, Param, Post } from '@nestjs/common';
import { ConnectorRelayAck } from '../connector.types';
import { ConnectorRelayService } from './connector-relay.service';

/** Agent-facing endpoints. Tenant identity comes only from the hashed relay bearer credential. */
@Controller('integrations/relay')
export class ConnectorRelayController {
  constructor(@Inject(ConnectorRelayService) private readonly relays: ConnectorRelayService) {}

  @Post(':relayId/poll')
  public async poll(
    @Param('relayId') relayId: string,
    @Headers('authorization') authorization?: string,
    @Body() body?: { waitSeconds?: number },
  ) {
    const delivery = await this.relays.poll(relayId, authorization, body?.waitSeconds);
    return { delivery };
  }

  @Post(':relayId/deliveries/:deliveryId/ack')
  public async acknowledge(
    @Param('relayId') relayId: string,
    @Param('deliveryId') deliveryId: string,
    @Headers('authorization') authorization?: string,
    @Body() body?: ConnectorRelayAck,
  ) {
    return this.relays.acknowledge(relayId, authorization, deliveryId, body as ConnectorRelayAck);
  }
}
