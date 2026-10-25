// Saved baskets live in Postgres, one row per shopper: `baskets (shopper_id text primary key, items jsonb)`.

export interface BasketItem {
  sku: string;
  quantity: number;
}

export interface SavedBasket {
  shopperId: string;
  items: BasketItem[];
}

// The slice of a Postgres client the repository uses; a `pg` Pool fits it.
export interface Sql {
  query<Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }>;
}

export interface RepositoryPorts {
  sql: Sql;
}

export async function loadBasket(ports: RepositoryPorts, shopperId: string): Promise<SavedBasket> {
  const { rows } = await ports.sql.query<{ items: BasketItem[] }>("select items from baskets where shopper_id = $1", [
    shopperId,
  ]);
  return { shopperId, items: rows[0]?.items ?? [] };
}

export async function saveBasket(ports: RepositoryPorts, { shopperId, items }: SavedBasket): Promise<void> {
  await ports.sql.query(
    "insert into baskets (shopper_id, items) values ($1, $2) on conflict (shopper_id) do update set items = excluded.items",
    [shopperId, JSON.stringify(items)],
  );
}
