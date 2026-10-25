import { loadBasket, saveBasket, type RepositoryPorts } from "../basket-repository/index.js";

// Declared here rather than imported from the basket service, which session restore has no relationship with.
interface Catalogue {
  find(sku: string): Promise<{ sku: string } | undefined>;
}

export class AddItemError extends Error {
  readonly status = 400;
}

export async function addItem(
  ports: RepositoryPorts & { catalogue: Catalogue },
  shopperId: string,
  sku: string,
  quantity: number,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new AddItemError("Quantity must be 1 to 99");
  if ((await ports.catalogue.find(sku)) === undefined) throw new AddItemError(`No product ${sku}`);
  const basket = await loadBasket(ports, shopperId);
  const item = basket.items.find((candidate) => candidate.sku === sku);
  if (item === undefined) basket.items.push({ sku, quantity });
  else if (item.quantity + quantity <= 99) item.quantity += quantity;
  else throw new AddItemError("Quantity must be 1 to 99");
  await saveBasket(ports, basket);
}
