import { describe, expect, it } from "vitest";
import { createApp } from "../support/app.js";

describe("#6 Change an item's quantity", () => {
  it("#6/AC1 shows the new quantity", async () => {
    const app = createApp();
    const token = app.signIn("ada");
    await app.post("/basket/items", token, { sku: "mug" });

    expect(await app.patch("/basket/items/mug", token, { quantity: 4 })).toEqual({ status: 204 });
    expect((await app.get("/basket", token)).body).toMatchObject({ lines: [{ sku: "mug", quantity: 4 }] });
  });

  it("#6/AC2 rejects a quantity outside 1 to 99 and keeps the old one", async () => {
    const app = createApp();
    const token = app.signIn("ada");
    await app.post("/basket/items", token, { sku: "mug", quantity: 2 });

    expect(await app.patch("/basket/items/mug", token, { quantity: 0 })).toMatchObject({ status: 400 });
    expect(await app.patch("/basket/items/mug", token, { quantity: 100 })).toMatchObject({ status: 400 });
    expect((await app.get("/basket", token)).body).toMatchObject({ lines: [{ sku: "mug", quantity: 2 }] });
  });
});
