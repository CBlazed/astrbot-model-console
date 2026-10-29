/** Hub-side client for a remote Model Console agent. The device token stays in memory only. */

export const AGENT_UNAUTHORIZED='AGENT_UNAUTHORIZED';
export const AGENT_UNREACHABLE='AGENT_UNREACHABLE';
export const AGENT_INVALID_RESPONSE='AGENT_INVALID_RESPONSE';
export const AGENT_RATE_LIMITED='AGENT_RATE_LIMITED';
export const AGENT_READ_ONLY='AGENT_READ_ONLY';
export const AGENT_TIMEOUT_MS=10000;

const TOKEN_PATTERN=/^[a-f0-9]{64}$/i;
const BASE_URL_PATTERN=/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/i;

const codedError=code=>{const error=Error(code);error.code=code;return error;};

/** HTTP success works for both real Response objects and minimal test doubles. */
const isSuccess=response=>typeof response?.ok==='boolean'?response.ok:Number(response?.status)>=200&&Number(response?.status)<300;

/**
 * Minimal read-only client for one agent (`/agent/v1/*`).
 *
 * `pair(code)` returns the 64-hex device token and remembers it for later calls.
 * Errors always carry `.code`: AGENT_UNAUTHORIZED (401 / missing token),
 * AGENT_RATE_LIMITED (429), AGENT_UNREACHABLE (network/timeout), AGENT_INVALID_RESPONSE
 * (non-2xx or malformed payload). Mockable `fetcher` and `timeoutMs` are test hooks.
 */
export class AgentAdapter{
  constructor({baseUrl,token,fetcher=fetch,timeoutMs=AGENT_TIMEOUT_MS}={}){
    if(typeof baseUrl!=='string'||!BASE_URL_PATTERN.test(baseUrl.trim()))throw codedError('AGENT_INVALID_BASE_URL');
    this.baseUrl=baseUrl.trim().replace(/\/+$/,'');
    this.token=typeof token==='string'&&TOKEN_PATTERN.test(token)?token.toLowerCase():null;
    this.fetcher=fetcher;
    this.timeoutMs=Number.isFinite(timeoutMs)&&timeoutMs>0?timeoutMs:AGENT_TIMEOUT_MS;
  }

  async #request(method,path,{body,requiresToken=false,relayErrors=false}={}){
    if(requiresToken&&!this.token)throw codedError(AGENT_UNAUTHORIZED);
    const headers={Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(requiresToken)headers.Authorization=`Bearer ${this.token}`;
    let response;
    try{
      response=await this.fetcher(`${this.baseUrl}${path}`,{
        method,
        headers,
        body:body===undefined?undefined:JSON.stringify(body),
        redirect:'error',
        signal:AbortSignal.timeout(this.timeoutMs),
      });
    }catch{
      throw codedError(AGENT_UNREACHABLE);
    }
    const status=Number(response?.status);
    if(isSuccess(response)){
      let parsed;
      try{parsed=await response.json();}catch{throw codedError(AGENT_INVALID_RESPONSE);}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw codedError(AGENT_INVALID_RESPONSE);
      return parsed;
    }
    if(status===401)throw codedError(AGENT_UNAUTHORIZED);
    if(status===429)throw codedError(AGENT_RATE_LIMITED);
    if(relayErrors){
      let payload=null;
      try{payload=await response.json();}catch{}
      if(status===403&&payload?.error===AGENT_READ_ONLY)throw codedError(AGENT_READ_ONLY);
      if(status===409){
        const raw=payload?.error;
        const code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(raw)?raw:AGENT_INVALID_RESPONSE;
        const error=codedError(code);
        error.status=409;
        if(payload&&typeof payload.details==='object'&&payload.details!==null)error.details=payload.details;
        throw error;
      }
    }
    throw codedError(AGENT_INVALID_RESPONSE);
  }

  /** Exchange a one-time pairing code for a device token. Returns the 64-hex token. */
  async pair(code){
    if(typeof code!=='string'||code.length===0||code.length>64)throw codedError(AGENT_INVALID_RESPONSE);
    const body=await this.#request('POST','/agent/v1/pair',{body:{code}});
    if(typeof body.token!=='string'||!TOKEN_PATTERN.test(body.token))throw codedError(AGENT_INVALID_RESPONSE);
    this.token=body.token.toLowerCase();
    return this.token;
  }

  /** Read the remote Engine snapshot. Requires a paired device token. */
  async snapshot(){
    return this.#request('GET','/agent/v1/snapshot',{requiresToken:true});
  }

  /**
   * Create a plan on a write-enabled agent. Returns the engine plan (id/changes/warning/expiresAt).
   * A read-only agent rejects with AGENT_READ_ONLY.
   */
  async plan({resource,changes,expectedRevision}={}){
    const body={resource,changes,...(expectedRevision===undefined?{}:{expectedRevision})};
    return this.#request('POST','/agent/v1/plans',{body,requiresToken:true,relayErrors:true});
  }

  /**
   * Apply a plan by id. Returns `{result,hotLoad}` where hotLoad is the agent's log-based evidence
   * ({verified,checked,note?,marker?}); its absence is never treated as a successful hot load.
   * Engine failures surface the agent error code and whitelisted details on the thrown error.
   */
  async apply(id){
    if(typeof id!=='string'||id.length===0)throw codedError(AGENT_INVALID_RESPONSE);
    const body=await this.#request('POST','/agent/v1/apply',{body:{id},requiresToken:true,relayErrors:true});
    if(!body||typeof body.result!=='object'||body.result===null||typeof body.hotLoad!=='object'||body.hotLoad===null)throw codedError(AGENT_INVALID_RESPONSE);
    return body;
  }

  /** List the write-enabled agent's backups: {backups,stats,limits}. */
  async backups(){
    const body=await this.#request('GET','/agent/v1/backups',{requiresToken:true,relayErrors:true});
    if(!Array.isArray(body.backups)||typeof body.stats!=='object'||body.stats===null||typeof body.limits!=='object'||body.limits===null)throw codedError(AGENT_INVALID_RESPONSE);
    return body;
  }

  /** Public health probe: {status:'ok',version}. */
  async health(){
    const body=await this.#request('GET','/agent/v1/health');
    if(body.status!=='ok')throw codedError(AGENT_INVALID_RESPONSE);
    return body;
  }

  /** No persistent transport yet; present so callers can close every device adapter uniformly. */
  async close(){}
}

/**
 * Convenience one-shot pairing for the device layer: POST /agent/v1/pair and return `{token}`.
 * Errors carry the same codes as AgentAdapter.pair.
 */
export async function pairAgent({baseUrl,pairingCode,fetcher}={}){
  const adapter=new AgentAdapter({baseUrl,fetcher});
  const token=await adapter.pair(pairingCode);
  await adapter.close();
  return {token};
}
