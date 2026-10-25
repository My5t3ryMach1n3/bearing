// Untagged on purpose: it serves no acceptance criterion, so it must never count as trace evidence.
import { expect, it } from "vitest";
import { isValidQuantity } from "../../src/basket-api/basket-service/quantity.js";

it("accepts whole quantities from 1 to 99", () => {
  expect([1, 99].map(isValidQuantity)).toEqual([true, true]);
  expect([0, 100, 1.5, "2", undefined].map(isValidQuantity)).toEqual([false, false, false, false, false]);
});
