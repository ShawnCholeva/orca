export async function probeHealth(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetchImpl(`${url}/v1/health`, { signal: controller.signal });
      if (!res.ok) return false;
      const body = (await res.json()) as { service?: string };
      return body.service === "orca-daemon";
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}
