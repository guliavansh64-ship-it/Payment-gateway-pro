import type { Order } from '../domain/models';
import type { OrderStatus } from '../domain/status';

/** Statuses in which the merchant is holding (or is owed) money. */
export const COMPLETED_STATUSES: readonly OrderStatus[] = [
  'PAID',
  'LATE_PAYMENT',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
];

export const AWAITING_STATUSES: readonly OrderStatus[] = ['CREATED', 'PENDING', 'VERIFYING'];

/** An incoming confirmed payment is late when it arrives after the deadline. */
export function isLate(order: Order, now: Date): boolean {
  return now.getTime() > order.expiresAt.getTime();
}
