// Aggregated, read-only cbrecorder metrics. Never return stream names, URLs or worker errors.
// Source contract: GET /api/state (authenticated HTTP Basic).
export function summarizeRecordStudio(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.streamers)) {
    throw new Error('Réponse Recordstudio invalide : tableau streamers absent');
  }
  if (data.streamers.length > 20000 || data.streamers.some(s =>
    !s || typeof s !== 'object' ||
    typeof s.state !== 'string' ||
    typeof s.enabled !== 'boolean'
  )) {
    throw new Error('Réponse Recordstudio invalide : états des salons incorrects');
  }
  const streams = data.streamers.filter(s => s.state === 'enregistrement').length;
  const errorCount = data.streamers.filter(s =>
    s.state.startsWith('erreur') || s.state === 'rate limit' || s.state === 'introuvable'
  ).length;
  const allNumeric = key => data.streamers.every(s => typeof s[key] === 'number' && Number.isFinite(s[key]) && s[key] >= 0);
  const sum = key => allNumeric(key) ? data.streamers.reduce((total,s) => total + s[key],0) : null;
  const freePercent = typeof data.disk?.free_percent === 'number' &&
    Number.isFinite(data.disk.free_percent) && data.disk.free_percent >= 0 && data.disk.free_percent <= 100
    ? data.disk.free_percent : null;
  return {
    ok: true,
    streams,
    configured: data.streamers.length,
    enabled: data.streamers.filter(s => s.enabled).length,
    errors: errorCount,
    files: sum('files'),
    recordingsBytes: sum('total_size'),
    freePercent,
    collectedAt: new Date().toISOString()
  };
}
