import { describe, expect, it } from "vitest";
import { createApp } from "../support/app.js";

describe("#2 Add an item to the basket", () => {
  it("#2/AC1 keeps an added item across sessions", async () => {
    const app = createApp();
    expect(await app.post("/basket/items", app.signIn("ada"), { sku: "pot" })).toEqual({ status: 204 });

    const { body } = await app.get("/basket", app.signIn("ada"));
    expect(body).toMatchObject({ lines: [{ sku: "pot", quantity: 1 }], total: 2400 });
  });

  it("#2/AC2 rejects a product that isn't in the catalogue and leaves the basket unchanged", async () => {
    const app = createApp();
    const token = app.signIn("ada");
    await app.post("/basket/items", token, { sku: "mug" });

    expect(await app.post("/basket/items", token, { sku: "kettle" })).toMatchObject({ status: 400 });
    expect((await app.get("/basket", token)).body).toMatchObject({ lines: [{ sku: "mug", quantity: 1 }] });
  });
});
