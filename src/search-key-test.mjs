/** Server-side "test this API key" probes for AstrBot's built-in web-search providers.
 *  Requests only go to fixed, reviewed hosts. Keys never appear in results, logs or errors. */

const SPECS = {
  tavily: {
    label: 'Tavily',
    request: (key) => ({
      url: 'https://api.tavily.com/search',
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'AstrBot', max_results: 1 }),
    }),
  },
  bocha: {
    label: 'Bocha',
    request: (key) => ({
      url: 'https://api.bochaai.com/v1/web-search',
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      body: JSON.stringify({ query: 'AstrBot', count: 1 }),
    }),
  },
  brave: {
    label: 'Brave',
    request: (key) => ({
      url: 'https://api.search.brave.com/res/v1/web/search?q=AstrBot&count=1',
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    }),
  },
  serpapi: {
    label: 'SerpApi',
    request: (key) => ({
      url: `https://serpapi.com/search.json?engine=google&q=AstrBot&api_key=${encodeURIComponent(key)}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
    }),
  },
  firecrawl: {
    label: 'Firecrawl',
    request: (key) => ({
      url: 'https://api.firecrawl.dev/v2/search',
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'AstrBot', limit: 1 }),
    }),
  },
  exa: {
    label: 'Exa',
    request: (key) => ({
      url: 'https://api.exa.ai/search',
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'AstrBot', numResults: 1 }),
    }),
  },
  anysearch: {
    label: 'AnySearch',
    request: (key) => ({
      url: 'https://api.anysearch.com/v1/search',
      method: 'POST',
      headers: key ? { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'AstrBot', max_results: 1, format: 'json' }),
    }),
  },
  deepseek: {
    label: 'DeepSeek Search API',
    request: (key) => ({
      url: 'https://api.deepseek.com/v1/tools/search',
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'AstrBot', count: 1, need_content: false }),
    }),
  },
  baidu_ai_search: {
    label: 'Baidu AI Search',
    request: (key) => ({
      url: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'X-Appbuilder-Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'AstrBot' }],
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: 1 }],
      }),
    }),
  },
};

export const supportedProviders = Object.keys(SPECS);
export function providerLabel(provider) { return SPECS[provider]?.label ?? String(provider ?? ''); }

function safeStatusMessage(status, provider) {
  if (status === 401 || status === 403) return provider === 'deepseek'
    ? `鉴权失败（HTTP ${status}）：DeepSeek API Key 缺失或无效。请在 platform.deepseek.com 检查/重新创建 Key（Search/Fetch 与模型共用同一个 Key）。`
    : `鉴权失败（HTTP ${status}）：Key 无效、过期或无权限。`;
  if (status === 402) return provider === 'deepseek'
    ? '余额不足（HTTP 402）：请先在 DeepSeek 平台充值后重试。'
    : '额度受限（HTTP 402）：请检查配额或充值。';
  if (status === 429) return `超过频率/QPS 限制（HTTP ${status}）：请稍后重试。`;
  if (status >= 500) return `搜索服务暂时不可用（HTTP ${status}），请稍后重试。`;
  return `请求被拒绝（HTTP ${status}），请检查 Key 与提供商配置。`;
}

/**
 * Probe one provider key with a minimal real search request.
 * @returns {{ok:boolean,provider:string,label:string,status:number|null,latencyMs:number,message:string}}
 */
export async function testSearchKey({ provider, key, fetcher = fetch, timeoutMs = 15000, signal } = {}) {
  const spec = SPECS[provider];
  if (!spec) return { ok: false, provider: String(provider ?? ''), label: '', status: null, latencyMs: 0, message: '不支持的搜索提供商。' };
  const apiKey = typeof key === 'string' ? key.trim() : '';
  if (!apiKey) return { ok: false, provider, label: spec.label, status: null, latencyMs: 0, message: '没有可测试的 Key：请先填写，或先保存 Key。' };

  const request = spec.request(apiKey);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 15000));
  const abort = () => controller.abort();
  if (signal?.addEventListener) signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'error',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const status = Number(response.status);
    if (status < 200 || status >= 300) {
      return { ok: false, provider, label: spec.label, status, latencyMs, message: safeStatusMessage(status, provider) };
    }
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (provider === 'anysearch' && body && body.code !== undefined && body.code !== 0 && body.code !== null) {
      return { ok: false, provider, label: spec.label, status, latencyMs, message: `AnySearch 业务错误（code=${String(body.code)}），请检查 Key 或参数。` };
    }
    if (provider === 'serpapi' && body) {
      const metaStatus = body?.search_metadata?.status;
      if (metaStatus === 'Error' || (body.error && metaStatus !== 'Success')) {
        return { ok: false, provider, label: spec.label, status, latencyMs, message: 'SerpApi 返回业务错误，请检查 Key 或配额。' };
      }
    }
    if (provider === 'deepseek' && Array.isArray(body?.results)) {
      return { ok: true, provider, label: spec.label, status, latencyMs, message: `连接成功，Key 可用（本次测试查询返回 ${body.results.length} 条结果）。` };
    }
    return { ok: true, provider, label: spec.label, status, latencyMs, message: '连接成功，Key 可用。' };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const timeout = error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR';
    return {
      ok: false,
      provider,
      label: spec.label,
      status: null,
      latencyMs,
      message: timeout ? '测试超时：请检查网络或稍后重试。' : '网络错误或请求失败：请检查本机网络与代理设置。',
    };
  } finally {
    clearTimeout(timer);
    if (signal?.removeEventListener) signal.removeEventListener('abort', abort);
  }
}
