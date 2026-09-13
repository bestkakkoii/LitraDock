import { describe, expect, it } from "vitest";
import { Article } from "./api";
import { searchId, selectedSearchIds, toggleArticle } from "./selection";

const article = (id: string): Article => ({ SearchId: id, Pmid: id });

describe("cross-page selection", () => {
  it("retains37 across saved pages and enforces the enabled100/101 boundary with deselection", () => {
    let selected = new Map<string, Article>();
    for (let i = 0; i < 37; i++) selected = toggleArticle(selected, article(`S${i}`), 100);
    expect(selectedSearchIds(selected)).toHaveLength(37);
    for (let i = 37; i < 101; i++) selected = toggleArticle(selected, article(`S${i}`), 100);
    expect(selected.size).toBe(100);
    expect(selected.has("S100")).toBe(false);
    selected = toggleArticle(selected, article("S0"), 100);
    selected = toggleArticle(selected, article("S100"), 100);
    expect(selected.size).toBe(100);
    expect(new Set(selectedSearchIds(selected)).size).toBe(100);
  });
  it("retains distinct stable IDs and supports toggle/deselection", () => {
    let selected = new Map<string, Article>();
    selected = toggleArticle(selected, article("S1"));
    selected = toggleArticle(selected, article("S2"));
    selected = toggleArticle(selected, article("S1"));
    expect(selectedSearchIds(selected)).toEqual(["S2"]);
    expect(searchId(article("S2"))).toBe("S2");
  });

  it("does not admit records without a stable SearchId", () => {
    const selected = toggleArticle(new Map(), { Pmid: "P1" });
    expect(selected.size).toBe(0);
  });
  it("caps selection at ten while still permitting deselection and replacement", () => {
    let selected = new Map<string, Article>();
    for (let i = 0; i < 11; i++) selected = toggleArticle(selected, article(`S${i}`));
    expect(selectedSearchIds(selected)).toEqual(Array.from({ length: 10 }, (_, i) => `S${i}`));
    selected = toggleArticle(selected, article("S0"));
    selected = toggleArticle(selected, article("S10"));
    expect(selected.size).toBe(10);
    expect(selected.has("S10")).toBe(true);
  });
});
