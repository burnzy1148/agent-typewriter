export interface Item {
  sku: string;
  price: number;
  qty: number;
}

export function subtotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
