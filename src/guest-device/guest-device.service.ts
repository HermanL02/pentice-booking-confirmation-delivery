import { Injectable, Logger } from '@nestjs/common';
import { DeviceStatusDto } from './dto/device-status.dto';
import { InboxMessageDto } from './dto/inbox-message.dto';

export interface InboxItem {
  deliveryId: string;
  kind: 'confirmation' | 'cancellation';
  confirmationCode: string;
  reservationId: string;
  receivedAt: string;
}

export type ReceiveResult = 'offline' | 'dropped' | 'duplicate' | 'received';

const ACK_TRIES = 3;
const ACK_RETRY_MS = 100;

@Injectable()
export class GuestDeviceService {
  private readonly logger = new Logger(GuestDeviceService.name);
  private online = true;
  private dropRate = 0;
  private seen = new Set<string>();
  private items: InboxItem[] = [];

  constructor(
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
    private readonly random: () => number = Math.random,
  ) {}

  status(): { online: boolean; dropRate: number } {
    return { online: this.online, dropRate: this.dropRate };
  }

  setStatus(s: DeviceStatusDto): void {
    this.online = s.online;
    this.dropRate = s.dropRate;
  }

  receive(msg: InboxMessageDto): ReceiveResult {
    if (!this.online) return 'offline';
    if (this.random() < this.dropRate) return 'dropped';
    if (this.seen.has(msg.deliveryId)) return 'duplicate';
    this.seen.add(msg.deliveryId);
    this.items.push({
      deliveryId: msg.deliveryId,
      kind: msg.kind ?? 'confirmation',
      confirmationCode: msg.confirmationCode,
      reservationId: msg.reservationId,
      receivedAt: new Date().toISOString(),
    });
    return 'received';
  }

  inbox(): InboxItem[] {
    return [...this.items];
  }

  reset(): void {
    this.seen = new Set<string>();
    this.items = [];
  }

  async acknowledge(ackUrl: string, ackToken: string): Promise<void> {
    try {
      for (let attempt = 1; attempt <= ACK_TRIES; attempt++) {
        try {
          const res = await this.fetchFn(ackUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ackToken }),
          });
          await res.body?.cancel().catch(() => undefined);
          if (res.ok) return;
        } catch {
          // fall through to retry
        }
        if (attempt < ACK_TRIES) {
          await new Promise<void>((r) => {
            setTimeout(r, ACK_RETRY_MS).unref();
          });
        }
      }
      this.logger.warn(`ack failed after ${ACK_TRIES} tries: ${ackUrl}`);
    } catch {
      // acknowledge must never reject
    }
  }
}
