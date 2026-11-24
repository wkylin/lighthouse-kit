// 页面路径 → 结果目录名。

export function pageSlug(page) {
  return page.replace(/^\//, '').replace(/[^a-zA-Z0-9/_-]/g, '_') || 'root'
}

/** 落到同一个目录的页面有相同的 key（结尾的 / 不区分目录）。 */
export const slugKey = (page) => pageSlug(page).replace(/\/+$/, '') || 'root'
