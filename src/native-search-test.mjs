/** Probe whether a provider model actually performs native web search via the Responses API.
 *  Uses the profile's own provider_source credentials server-side; keys never leave the process. */

function providerSource(config, providerId) {
  const entry = (config?.provider ?? []).find((item) => item.id === providerId);
  if (!entry) return null;
  const source = (config?.provider_sources ?? []).find((item) => item.id === entry.provider_source_id) ?? {};
  const key = Array.isArray(source.key) ? source.key.find((item) => typeof item === 'string' && item) : source.key;
  return { entry, source, key, model: entry.model ?? source.model ?? '', apiBase: String(source.api_base ?? '').replace(/\/$/, '') };
}

function safeError(status) {
  if (status === 401 || status === 403) return `鉴权失败（HTTP ${status}）：Key 无效、过期或无权限。`;
  if (status === 402 || status === 429) return `额度或频率受限（HTTP ${status}）。`;
  if (status === 404) return '该 provider 不支持 Responses API（HTTP 404），无法使用模型原生搜索。';
  if (status >= 500) return `搜索服务暂时不可用（HTTP ${status}）。`;
  return `请求被拒绝（HTTP ${status}）。`;
}

/**
 * @returns {{ok:boolean,provider:string,model:string,status:number|null,latencyMs:number,searchCalls:number,citations:number,message:string}}
 */
export async function testNativeSearch({ config, providerId, fetcher = fetch, timeoutMs = 60000 } = {}) {
  const resolved = providerSource(config, providerId);
  if (!resolved) return { ok: false, provider: String(providerId ?? ''), model: '', status: null, latencyMs: 0, searchCalls: 0, citations: 0, message: '找不到该模型 Provider。' };
  const { model, apiBase, key, entry } = resolved;
  if (!apiBase || !key) return { ok: false, provider: providerId, model, status: null, latencyMs: 0, searchCalls: 0, citations: 0, message: '该 Provider 缺少 api_base 或 Key，无法测试。' };
  const started = Date.now();
  try {
    const response = await fetcher(`${apiBase}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        instructions: 'Use the web_search tool to find current information. Answer briefly and cite at least one URL.',
        input: 'What is a recent notable news item? Cite one source URL.',
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto',
        max_output_tokens: 800,
        store: false,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 60000)),
    });
    const latencyMs = Date.now() - started;
    const status = Number(response.status);
    if (status < 200 || status >= 300) {
      return { ok: false, provider: providerId, model, status, latencyMs, searchCalls: 0, citations: 0, message: safeError(status) };
    }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    const output = Array.isArray(body?.output) ? body.output : [];
    const searchCalls = output.filter((item) => item?.type === 'web_search_call').length;
    const citations = output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .flatMap((part) => (Array.isArray(part?.annotations) ? part.annotations : []))
      .filter((annotation) => annotation?.type === 'url_citation' || annotation?.url).length;
    if (searchCalls === 0 && citations === 0) {
      return {
        ok: false, provider: providerId, model, status, latencyMs, searchCalls, citations,
        message: '模型没有实际执行 web_search（可能不支持原生搜索；DeepSeek 官方目前仅 deepseek-v4-pro 支持 Responses web_search）。',
      };
    }
    return { ok: true, provider: providerId, model, status, latencyMs, searchCalls, citations, message: `模型原生搜索可用（web_search_call ${searchCalls} 次，引用 ${citations} 条）。` };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const timeout = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return { ok: false, provider: providerId, model, status: null, latencyMs, searchCalls: 0, citations: 0, message: timeout ? '测试超时：模型在限定时间内没有返回。' : '网络错误或请求失败：请检查 provider 地址与网络。' };
  }
}
