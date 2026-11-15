export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
  offset: number;
  previous: number | null;
  next: number | null;
}

export function paginate<T>(items: readonly T[], { page = 1, pageSize = 10 } = {}): Page<T> {
  if (!Array.isArray(items)) throw new TypeError("paginate expects an array");
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError("page must be an integer and pageSize a positive integer");
  }
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.max(1, Math.min(page, pages));
  const offset = (current - 1) * pageSize;
  return {
    items: items.slice(offset, offset + pageSize),
    page: current, pageSize, total, pages, offset,
    previous: current > 1 ? current - 1 : null,
    next: current < pages ? current + 1 : null,
  };
}

export function numberedLines<T>(result: Page<T>, render: (item: T, number: number) => string = String) {
  return result.items.map((item, index) => {
    const number = result.offset + index + 1;
    return `${number}. ${render(item, number)}`;
  });
}
