import { Article } from "../api";

export type SavedMember = { searchID: string; runIDs: string[] };
export type BasketMember = SavedMember & { article: Article };
export const associationCount = (members: SavedMember[]) => members.reduce((sum, item) => sum + item.runIDs.length, 0);
export function validateMembers(members: SavedMember[]) {
  if (!members.length || members.length > 100 || new Set(members.map(item => item.searchID)).size !== members.length ||
      members.some(item => !item.searchID || !item.runIDs.length || item.runIDs.some(id => !id) || new Set(item.runIDs).size !== item.runIDs.length) ||
      associationCount(members) > 1000) throw new Error("Choose up to 100 unique saved records and 1,000 record/run associations.");
}
// Transactional merge: a rejected addition never leaves a partially filled basket.
// Record order is first addition; run associations are explicit, not inferred.
export function addToBasket(previous: BasketMember[], runID: string, articles: Article[]): BasketMember[] {
  if (!runID) throw new Error("Open a saved search before adding records.");
  const merged = previous.map(item => ({ ...item, runIDs: [...item.runIDs] }));
  for (const article of articles) {
    const searchID = article.SearchId;
    if (!searchID) throw new Error("A selected record has no saved Search ID. Refresh the saved search.");
    const existing = merged.find(item => item.searchID === searchID);
    if (existing) { if (!existing.runIDs.includes(runID)) existing.runIDs.push(runID); }
    else merged.push({ searchID, runIDs: [runID], article });
  }
  if (merged.length) validateMembers(merged);
  return merged;
}
export function savedMembers(members: SavedMember[]): SavedMember[] {
  validateMembers(members);
  return members.map(item => ({ searchID: item.searchID, runIDs: [...item.runIDs].sort() }));
}
