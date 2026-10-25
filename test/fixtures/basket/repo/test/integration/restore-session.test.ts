import { describe, expect, it } from "vitest";
import { createApp } from "../support/app.js";

describe("#4 Restore the basket after the session expires", () => {
  it("#4/AC1 restores the saved basket when the shopper signs in again", async () => {
    const app = createApp();
    const token = app.signIn("ada");
    await app.post("/basket/items", token, { sku: "tea", quantity: 3 });
    app.advanceMinutes(45);

    expect(await app.post("/session/restore", app.signIn("ada"))).toEqual({
      status: 200,
      body: { shopperId: "ada", items: [{ sku: "tea", quantity: 3 }] },
    });
  });

  it("#4/AC2 rejects changes on an expired session and leaves the saved basket unchanged", async () => {
    const app = createApp();
    const token = app.signIn("ada");
    await app.post("/basket/items", token, { sku: "tea" });
    app.advanceMinutes(45);

    expect(await app.post("/basket/items", token, { sku: "mug" })).toMatchObject({ status: 401 });
    expect((await app.post("/session/restore", app.signIn("ada"))).body).toMatchObject({
      items: [{ sku: "tea", quantity: 1 }],
    });
  });
});
