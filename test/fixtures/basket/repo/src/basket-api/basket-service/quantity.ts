export const maxQuantity = 99;

export function isValidQuantity(quantity: unknown): quantity is number {
  return Number.isInteger(quantity) && (quantity as number) >= 1 && (quantity as number) <= maxQuantity;
}
