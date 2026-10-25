import { loadBasket, saveBasket, type RepositoryPorts } from "../basket-repository/index.js";
import type { Catalogue } from "./catalogue.js";
import { isValidQuantity, maxQuantity } from "./quantity.js";

export type { Catalogue, Product } from "./catalogue.js";

export type ServicePorts = RepositoryPorts & { catalogue: Catalogue };

export interface BasketLine {
  sku: string;
  name: string;
  price: number;
  quantity: number;
}

export interface PricedBasket {
  lines: BasketLine[];
  total: number;
}

export class BasketError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "BasketError";
  }
}

// Prices the basket at today's catalogue prices, not the prices when items were added.
export async function getBasket(ports: ServicePorts, shopperId: string): Promise<PricedBasket> {
  const { items } = await loadBasket(ports, shopperId);
  const lines: BasketLine[] = [];
  for (const { sku, quantity } of items) {
    const product = await ports.catalogue.find(sku);
    // A product withdrawn from sale drops out of the priced basket but stays saved, in case it comes back.
    if (product !== undefined) lines.push({ sku, name: product.name, price: product.price, quantity });
  }
  return { lines, total: lines.reduce((sum, line) => sum + line.price * line.quantity, 0) };
}

export async function addItem(ports: ServicePorts, shopperId: string, sku: string, quantity: number): Promise<void> {
  if (!isValidQuantity(quantity)) throw new BasketError(400, `Quantity must be 1 to ${maxQuantity}`);
  if ((await ports.catalogue.find(sku)) === undefined) throw new BasketError(400, `No product ${sku}`);
  const basket = await loadBasket(ports, shopperId);
  const item = basket.items.find((candidate) => candidate.sku === sku);
  if (item === undefined) basket.items.push({ sku, quantity });
  else if (isValidQuantity(item.quantity + quantity)) item.quantity += quantity;
  else throw new BasketError(400, `Quantity must be 1 to ${maxQuantity}`);
  await saveBasket(ports, basket);
}

export async function removeItem(ports: ServicePorts, shopperId: string, sku: string): Promise<void> {
  const basket = await loadBasket(ports, shopperId);
  const items = basket.items.filter((item) => item.sku !== sku);
  if (items.length === basket.items.length) throw new BasketError(404, `${sku} isn't in the basket`);
  await saveBasket(ports, { shopperId, items });
}

export async function setQuantity(
  ports: ServicePorts,
  shopperId: string,
  sku: string,
  quantity: number,
): Promise<void> {
  if (!isValidQuantity(quantity)) throw new BasketError(400, `Quantity must be 1 to ${maxQuantity}`);
  const basket = await loadBasket(ports, shopperId);
  const item = basket.items.find((candidate) => candidate.sku === sku);
  if (item === undefined) throw new BasketError(404, `${sku} isn't in the basket`);
  item.quantity = quantity;
  await saveBasket(ports, basket);
}

export async function clearBasket(ports: ServicePorts, shopperId: string): Promise<void> {
  await saveBasket(ports, { shopperId, items: [] });
}
