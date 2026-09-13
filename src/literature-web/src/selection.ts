import { Article } from "./api";

export function searchId(article: Article): string {
  return typeof article.SearchId === "string" ? article.SearchId : "";
}

export function toggleArticle(
  current: Map<string, Article>,
  article: Article,
  maximum = 10,
): Map<string, Article> {
  const id = searchId(article);
  if (!id) return current;
  if (!current.has(id) && current.size >= maximum) return current;
  const next = new Map(current);
  next.has(id) ? next.delete(id) : next.set(id, article);
  return next;
}

export function selectedSearchIds(current: Map<string, Article>): string[] {
  return [...current.keys()];
}
