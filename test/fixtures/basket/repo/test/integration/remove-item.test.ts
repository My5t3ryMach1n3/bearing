import { describe, expect, it } from "vitest";
import { createApp } from "../support/app.js";

describe("#3 Remove an item from the basket", () => {
  it("#3/AC1 removes the item", async () => {
    const app = createApp();
    const token = app.signIn("ada");
    await app.post("/basket/items", token, { sku: "mug" });
    await app.post("/basket/items", token, { sku: "tea" });

    expect(await app.delete("/basket/items/mug", token)).toEqual({ status: 204 });
    expect((await app.get("/basket", token)).body).toMatchObject({ lines: [{ sku: "tea" }] });
  });

  it("#3/AC2 rejects removing an item that isn't in the basket as not found", async () => {
    const app = createApp();
    expect(await app.delete("/basket/items/mug", app.signIn("ada"))).toMatchObject({ status: 404 });
  });
});
