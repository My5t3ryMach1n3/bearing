// Runs the basket API against in-memory stand-ins for Postgres, the identity provider and the product catalogue.
import { handle, type Ports } from "../../src/basket-api/basket-controller/index.js";

const products = [
  { sku: "mug", name: "Enamel mug", price: 899 },
  { sku: "tea", name: "Loose-leaf tea", price: 450 },
  { sku: "pot", name: "Teapot", price: 2400 },
];

export function createApp() {
  let now = new Date("2026-10-26T09:00:00Z");
  const sessions = new Map<string, { subject: string; expiresAt: Date }>();
  const baskets = new Map<string, string>();
  const catalogue = new Map(products.map((product) => [product.sku, { ...product }]));

  const ports: Ports = {
    now: () => now,
    identityProvider: {
      async introspect(token) {
        const session = sessions.get(token);
        return session === undefined ? { active: false } : { active: true, ...session };
      },
    },
    catalogue: {
      async find(sku) {
        return catalogue.get(sku);
      },
    },
    sql: {
      async query<Row>(text: string, values: unknown[]) {
        const [shopperId, items] = values as [string, string?];
        if (text.startsWith("select items from baskets")) {
          const saved = baskets.get(shopperId);
          return { rows: (saved === undefined ? [] : [{ items: JSON.parse(saved) }]) as Row[] };
        }
        if (text.startsWith("insert into baskets") && items !== undefined) {
          baskets.set(shopperId, items);
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    },
  };

  const request = (method: string, path: string, token?: string, body?: unknown) =>
    handle(ports, { method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, body });

  return {
    // Signs a shopper in and returns their token, valid for 30 minutes.
    signIn(shopperId: string): string {
      const token = `token-${sessions.size + 1}`;
      sessions.set(token, { subject: shopperId, expiresAt: new Date(now.getTime() + 30 * 60_000) });
      return token;
    },
    advanceMinutes(minutes: number) {
      now = new Date(now.getTime() + minutes * 60_000);
    },
    setPrice(sku: string, price: number) {
      const product = catalogue.get(sku);
      if (product === undefined) throw new Error(`No product ${sku}`);
      product.price = price;
    },
    get: (path: string, token?: string) => request("GET", path, token),
    post: (path: string, token?: string, body?: unknown) => request("POST", path, token, body),
    patch: (path: string, token?: string, body?: unknown) => request("PATCH", path, token, body),
    delete: (path: string, token?: string) => request("DELETE", path, token),
  };
}
