import { useEffect, useRef, useState } from "react";
import { articleTypes, emptyFilters, filterCount, Filters, textAvailability } from "../searchFilters";

export function SearchFilters({ filters, onChange, disabled, canSearch, appliedRun }: {
  filters: Filters; onChange: (filters: Filters) => void; disabled: boolean; canSearch: boolean; appliedRun?: string;
}) {
  const panel = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(() => window.matchMedia("(min-width: 900px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 900px)");
    const change = () => setOpen(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (appliedRun && !window.matchMedia("(min-width: 900px)").matches) {
      if (panel.current?.contains(document.activeElement)) document.getElementById("results-heading")?.focus({ preventScroll: true });
      setOpen(false);
    }
  }, [appliedRun]);
  return <details ref={panel} className="search-filters panel" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Filters {filterCount(filters) ? <span className="count">{filterCount(filters)}</span> : <span className="muted small">Date · type · text</span>}</summary>
    <fieldset disabled={disabled}>
      <legend>Publication years</legend>
      <div className="year-range">
        <label>From<input aria-label="Publication year from" inputMode="numeric" maxLength={4} placeholder="e.g. 2020" value={filters.from} onChange={e => onChange({ ...filters, from: e.target.value })} /></label>
        <label>To<input aria-label="Publication year to" inputMode="numeric" maxLength={4} placeholder="e.g. 2026" value={filters.to} onChange={e => onChange({ ...filters, to: e.target.value })} /></label>
      </div>
    </fieldset>
    <fieldset disabled={disabled}>
      <legend>Article type</legend>
      {Object.entries(articleTypes).map(([key, value]) => <label className="check-label" key={key}>
        <input type="checkbox" checked={filters.types.includes(key as Filters["types"][number])} onChange={e => onChange({ ...filters, types: e.target.checked ? [...filters.types, key as Filters["types"][number]] : filters.types.filter(type => type !== key) })} />{value.label}
      </label>)}
    </fieldset>
    <label className="filter-text">Text availability
      <select aria-label="Text availability" disabled={disabled} value={filters.text} onChange={e => onChange({ ...filters, text: e.target.value as Filters["text"] })}>
        {Object.entries(textAvailability).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
      </select>
    </label>
    <p className="muted small">A full-text link does not guarantee a downloadable PDF.</p>
    <div className="filter-actions">
      <button type="submit" form="pubmed-search" disabled={disabled || !canSearch}>Apply filters</button>
      <button type="button" className="secondary" disabled={disabled || !filterCount(filters)} onClick={() => onChange(emptyFilters())}>Clear filters</button>
    </div>
    <details className="filter-help"><summary>About these filters</summary><p>Article types may omit records that have not been indexed. Systematic review uses PubMed's systematic-review strategy. Multiple article types are combined with OR; the date and availability choices use AND.</p></details>
  </details>;
}

export function FilterChips({ filters, onChange, disabled }: { filters: Filters; onChange: (filters: Filters) => void; disabled: boolean }) {
  return <div className="filter-chips" aria-label="Chosen filters">
    {(filters.from || filters.to) && <button className="secondary" disabled={disabled} onClick={() => onChange({ ...filters, from: "", to: "" })} aria-label="Remove publication year filter">{filters.from || "…"}–{filters.to || "…"} ×</button>}
    {filters.types.map(type => <button key={type} className="secondary" disabled={disabled} onClick={() => onChange({ ...filters, types: filters.types.filter(key => key !== type) })} aria-label={`Remove ${articleTypes[type].label} filter`}>{articleTypes[type].label} ×</button>)}
    {filters.text && <button className="secondary" disabled={disabled} onClick={() => onChange({ ...filters, text: "" })} aria-label="Remove text availability filter">{textAvailability[filters.text].label} ×</button>}
  </div>;
}
