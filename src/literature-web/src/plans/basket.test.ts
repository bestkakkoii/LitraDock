import { expect, it } from "vitest";
import { addToBasket, associationCount, savedMembers } from "./basket";

const records = (count: number) => Array.from({ length: count }, (_, index) => ({ SearchId: `synthetic-${index}`, Title: `SYNTHETIC 中文 ${index}` }));
it("merges pages and actual run associations without duplicates or changing first-added order", () => {
  let basket = addToBasket([], "R2", records(2));
  basket = addToBasket(basket, "R1", records(3));
  basket = addToBasket(basket, "R1", records(3));
  expect(basket.map(item => item.searchID)).toEqual(["synthetic-0", "synthetic-1", "synthetic-2"]);
  expect(associationCount(basket)).toBe(5);
  expect(savedMembers(basket)[0]).toEqual({ searchID: "synthetic-0", runIDs: ["R1", "R2"] });
  expect(basket[0].article.Title).toBe("SYNTHETIC 中文 0");
});
it.each([1, 10, 11, 37, 100])("admits %i actually saved records independent of provider total", count => {
  expect(addToBasket([], "R", records(count))).toHaveLength(count);
});
it("rejects101 and1001 atomically, accepts1000 associations and preserves a removable subset", () => {
  let basket = addToBasket([], "R0", records(100));
  expect(() => addToBasket(basket, "R0", records(101))).toThrow();
  expect(basket).toHaveLength(100);
  for (let i = 1; i < 10; i++) basket = addToBasket(basket, `R${i}`, records(100));
  expect(associationCount(basket)).toBe(1000);
  expect(() => addToBasket(basket, "R10", records(1))).toThrow();
  expect(associationCount(basket)).toBe(1000);
  const subset = basket.filter(item => item.searchID !== "synthetic-0");
  expect(savedMembers(subset)).toHaveLength(99);
  expect(() => savedMembers([])).toThrow();
});
