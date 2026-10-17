export const DELIVERY_ATTENTION = 'delivery.attention';

/** Emitted once per delivery, when it first reaches the attention threshold. */
export interface DeliveryAttentionEvent {
  deliveryId: string;
  attempts: number;
}
