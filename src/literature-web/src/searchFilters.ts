// Visual filters only add documented PubMed clauses. The complete expression is
// persisted by the existing search API; no browser storage becomes provenance.
export const articleTypes = {
  review: { label: "Review", clause: '"Review"[pt]' },
  clinical: { label: "Clinical trial", clause: '"Clinical Trial"[pt]' },
  randomized: { label: "Randomized controlled trial", clause: '"Randomized Controlled Trial"[pt]' },
  meta: { label: "Meta-analysis", clause: '"Meta-Analysis"[pt]' },
  systematic: { label: "Systematic review", clause: "systematic[sb]" },
} as const;
export const textAvailability = {
  "": { label: "Any availability", clause: "" },
  abstract: { label: "Has abstract", clause: "hasabstract" },
  full: { label: "Full text", clause: "full text[sb]" },
  free: { label: "Free full text", clause: "free full text[sb]" },
} as const;
export type Filters = { from: string; to: string; types: (keyof typeof articleTypes)[]; text: keyof typeof textAvailability };
export const emptyFilters = (): Filters => ({ from: "", to: "", types: [], text: "" });
export const filterCount = (filters: Filters) => Number(!!(filters.from || filters.to)) + filters.types.length + Number(!!filters.text);

function balanced(query: string) {
  let depth = 0, quoted = false, field = false;
  for (const char of query) {
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "[") field = true;
    if (char === "]") field = false;
    if (field) continue;
    if (char === "(") depth++;
    if (char === ")" && --depth < 0) return false;
  }
  return depth === 0 && !quoted && !field;
}

export function composeSearch(query: string, filters: Filters): string {
  const clauses: string[] = [];
  if (filters.from || filters.to) {
    if (!/^\d{4}$/.test(filters.from) || !/^\d{4}$/.test(filters.to) || Number(filters.from) < 1000 || Number(filters.from) > Number(filters.to))
      throw new Error("Enter a valid start and end year, with the start no later than the end.");
    clauses.push(`${filters.from}:${filters.to}[dp]`);
  }
  const types = Object.keys(articleTypes).filter(key => filters.types.includes(key as keyof typeof articleTypes)) as (keyof typeof articleTypes)[];
  if (types.length) clauses.push(types.map(key => articleTypes[key].clause).join(" OR "));
  if (filters.text) clauses.push(textAvailability[filters.text].clause);
  if (!query.trim()) throw new Error("Enter a topic or PubMed query.");
  if (clauses.length && !balanced(query)) throw new Error("Close the query's quotes, parentheses and field brackets before applying visual filters.");
  const effective = clauses.length ? `(${query}) AND ${clauses.map(clause => `(${clause})`).join(" AND ")}` : query;
  if (effective.length > 2000) throw new Error("The query and filters exceed 2,000 characters. Shorten the query before searching.");
  return effective;
}

// Reopen only the exact canonical expression we can reconstruct byte for byte.
// An arbitrary historic/advanced query stays intact in the query field.
export function restoreSearch(effective: string): { query: string; filters: Filters } {
  const fallback = { query: effective, filters: emptyFilters() };
  const filters = emptyFilters();
  let remaining = effective;
  for (const [key, value] of Object.entries(textAvailability)) {
    if (key && remaining.endsWith(` AND (${value.clause})`)) {
      filters.text = key as Filters["text"];
      remaining = remaining.slice(0, -` AND (${value.clause})`.length);
      break;
    }
  }
  const typeTail = remaining.match(/ AND \(([^()]+)\)$/);
  if (typeTail) {
    const clauses = typeTail[1].split(" OR ");
    const keys = clauses.map(clause => Object.keys(articleTypes).find(key => articleTypes[key as keyof typeof articleTypes].clause === clause));
    if (keys.every(Boolean)) { filters.types = keys as Filters["types"]; remaining = remaining.slice(0, -typeTail[0].length); }
  }
  const dateTail = remaining.match(/ AND \((\d{4}):(\d{4})\[dp\]\)$/);
  if (dateTail) { filters.from = dateTail[1]; filters.to = dateTail[2]; remaining = remaining.slice(0, -dateTail[0].length); }
  if (!filterCount(filters) || !remaining.startsWith("(") || !remaining.endsWith(")")) return fallback;
  const query = remaining.slice(1, -1);
  try { return composeSearch(query, filters) === effective ? { query, filters } : fallback; }
  catch { return fallback; }
}
