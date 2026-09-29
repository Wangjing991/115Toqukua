'use strict';
// OpenList-API's documented callback carries a base64 JSON payload in the
// fragment. Accept only the HTTPS tool origin and the 115 driver identifier.
function parse115Callback(value) {
  try {
    if (typeof value !== 'string' || value.length > 128000) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'api.oplist.org' || url.port || !url.hash) return null;
    const encoded = decodeURIComponent(url.hash.slice(1));
    if (!/^[A-Za-z0-9+/_=-]+$/.test(encoded)) return null;
    const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (data.driver_txt !== '115cloud_go') return null;
    const valid = key => typeof data[key] === 'string' && data[key].trim().length > 0 && data[key].length <= 32000 && !/[\r\n]/.test(data[key]);
    if (!valid('access_token') || !valid('refresh_token')) return null;
    return { accessToken: data.access_token.trim(), refreshToken: data.refresh_token.trim() };
  } catch { return null; }
}
module.exports = { parse115Callback };
