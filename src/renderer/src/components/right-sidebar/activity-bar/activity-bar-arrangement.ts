export function arrangeActivityItems<T extends { id: string }>(items: T[], order: string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const result: T[] = []
  for (const id of order) {
    const item = byId.get(id)
    if (item) {
      result.push(item)
      byId.delete(id)
    }
  }
  return [...result, ...byId.values()]
}

export function mergeActivityOrder(saved: string[], reordered: string[]): string[] {
  const available = new Set(reordered)
  const slots = [...new Set([...saved, ...reordered])]
  let index = 0
  return slots.map((id) => (available.has(id) ? reordered[index++] : id))
}
