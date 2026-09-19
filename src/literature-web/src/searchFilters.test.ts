import { describe, expect, it } from "vitest";
import { composeSearch, emptyFilters, restoreSearch } from "./searchFilters";

describe("visual filters preserve the complete submitted query", () => {
  it.each([
    'asthma OR COPD',
    '"heart failure"[Title] AND (therapy OR prevention) NOT animals[mh]',
    '(metformin[Title/Abstract] OR "Diabetes Mellitus, Type 2"[MeSH Terms])',
    '"quoted (parentheses)"[Title] OR 中文',
    '(asthma) AND ("Review"[pt])',
  ])("groups the entered expression as one operand: %s", query => {
    const filters = { ...emptyFilters(), from: "2020", to: "2024", types: ["review", "systematic"] as const, text: "free" as const };
    const selected = { ...filters, types: [...filters.types] };
    const expected = `(${query}) AND (2020:2024[dp]) AND ("Review"[pt] OR systematic[sb]) AND (free full text[sb])`;
    expect(composeSearch(query, selected)).toBe(expected);
    expect(restoreSearch(expected)).toEqual({ query, filters: selected });
    expect(composeSearch(query, emptyFilters())).toBe(query);
  });
  it("does not reinterpret historic expressions or similar text inside quotes", () => {
    for (const query of ['asthma AND 2020:2024[dp]', 'asthma OR "Review"[pt]', '(asthma) AND (unknown[sb])', '" AND (free full text[sb])"', '(asthma) and (hasabstract)'])
      expect(restoreSearch(query)).toEqual({ query, filters: emptyFilters() });
  });
  it("keeps systematic-review strategy distinct from publication type", () => {
    const result = composeSearch("asthma", { ...emptyFilters(), types: ["systematic"] });
    expect(result).toBe('(asthma) AND (systematic[sb])');
    expect(result).not.toContain('[pt]');
  });
  it("removes only the selected visual clause and restores original bytes", () => {
    const query = '"free full text[sb]" OR asthma[Title]';
    const { filters, query: base } = restoreSearch(composeSearch(query, { ...emptyFilters(), text: "free" }));
    expect(composeSearch(base, { ...filters, text: "" })).toBe(query);
  });
  it.each([['2026', '2020'], ['2020', ''], ['', '2026'], ['0', '2026'], ['1000 OR all[sb]', '2026']])("rejects invalid year pair %s / %s", (from, to) => {
    expect(() => composeSearch("asthma", { ...emptyFilters(), from, to })).toThrow("valid start and end year");
  });
  it.each(['(asthma', 'asthma)', '"asthma', 'asthma[Title'])("never silently repairs an incomplete expression when adding filters: %s", query => {
    expect(() => composeSearch(query, { ...emptyFilters(), text: "abstract" })).toThrow("Close the query");
    expect(composeSearch(query, emptyFilters())).toBe(query);
  });
  it("validates the complete effective length instead of silently truncating", () => {
    const query = "a".repeat(2000);
    expect(composeSearch(query, emptyFilters())).toBe(query);
    expect(() => composeSearch(query, { ...emptyFilters(), text: "full" })).toThrow("2,000");
  });
});
