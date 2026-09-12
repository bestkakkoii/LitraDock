/** Saved-record pagination is bounded by the persisted page total, not provider total. */
export function canAdvanceRecords(pageTotal: number, offset: number, pageCount: number): boolean {
  return pageTotal > 0 && offset + pageCount < pageTotal;
}
