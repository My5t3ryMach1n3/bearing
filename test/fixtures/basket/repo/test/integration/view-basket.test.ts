import { describe, expect, it } from "vitest";
import { createApp } from "../support/app.js";

describe("#1 View the basket", () => {
  it("#1/AC1 lists each item with its name, current price and quantity, and the total", async () => {
    const app = createApp();
    const token = app.signIn("ada");
    await app.post("/basket/items", token, { sku: "mug", quantity: 2 });
    await app.post("/basket/items", token, { sku: "tea" });
    app.setPrice("mug", 950);

    expect(await app.get("/basket", token)).toEqual({
      status: 200,
      body: {
        lines: [
          { sku: "mug", name: "Enamel mug", price: 950, quantity: 2 },
          { sku: "tea", name: "Loose-leaf tea", price: 450, quantity: 1 },
        ],
        total: 2350,
      },
    });
  });

  it("#1/AC2 shows an empty basket with a zero total", async () => {
    const app = createApp();
    expect(await app.get("/basket", app.signIn("ada"))).toEqual({ status: 200, body: { lines: [], total: 0 } });
  });
});
