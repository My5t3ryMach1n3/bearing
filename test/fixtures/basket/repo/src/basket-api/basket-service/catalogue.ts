export interface Product {
  sku: string;
  name: string;
  // In pence.
  price: number;
}

// The product catalogue's API, as the basket service sees it.
export interface Catalogue {
  find(sku: string): Promise<Product | undefined>;
}
