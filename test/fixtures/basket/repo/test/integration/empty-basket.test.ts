import { describe, expect, it } from "vitest";
import { createApp } from "../support/app.js";

describe("#7 Empty the basket", () => {
  it("#7/AC1 empties the basket", async () => {
    const app = createApp();
    const token = app.signIn("ada");
    await app.post("/basket/items", token, { sku: "mug" });
    await app.post("/basket/items", token, { sku: "pot" });

    expect(await app.delete("/basket", token)).toEqual({ status: 204 });
    expect(await app.get("/basket", token)).toEqual({ status: 200, body: { lines: [], total: 0 } });
  });
});
