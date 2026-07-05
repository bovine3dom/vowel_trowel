export function resolveAudioSource(src: string): string {
  if (/^(https?:|data:|blob:|\/)/.test(src)) {
    return src;
  }

  const base = import.meta.env.BASE_URL || "./";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;

  return `${normalizedBase}${src}`;
}
