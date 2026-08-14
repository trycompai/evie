/**
 * Bot slugs.
 *
 * A slug is `unique (org_id, slug)` and becomes part of a URL, so it has to be
 * stable, lowercase, and free of anything a path segment would have to encode.
 * Two bots named "Chief of Staff" in one org is a normal thing to want, so the
 * caller disambiguates with `withSuffix` rather than the user being told no.
 */

const MAX = 48

export const slugify = (name: string): string => {
  const base = name
    .normalize("NFKD")
    // Strip combining marks so "Résumé" becomes "resume" rather than "rsum".
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX)
    .replace(/-+$/g, "")

  // A bot named entirely in a non-Latin script slugifies to nothing. "bot" is a
  // worse name than the user's, and it is still addressable -- the display name
  // is untouched and the suffix makes it unique.
  return base.length > 0 ? base : "bot"
}

/** `chief-of-staff` -> `chief-of-staff-2`. Truncates the base, never the suffix. */
export const withSuffix = (slug: string, n: number): string => {
  const suffix = `-${n}`
  return slug.slice(0, MAX - suffix.length) + suffix
}

/**
 * @param taken Slugs already used in this organization.
 */
export const uniqueSlug = (name: string, taken: ReadonlySet<string>): string => {
  const base = slugify(name)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = withSuffix(base, n)
    if (!taken.has(candidate)) return candidate
  }
}
