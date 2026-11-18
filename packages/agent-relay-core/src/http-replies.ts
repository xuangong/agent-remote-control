import { type Host, type RpcResponse } from './broker-types.js';

export function json(status: number, value: unknown) { return rawJson({ status, body: JSON.stringify(value) }); }
export function rawJson(result: RpcResponse) {
  const body = [204, 205, 304].includes(result.status) ? null : result.body;
  return new Response(body, { status: result.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
export function rejectUpgrade(status: number) { return new Response(null, { status }); }
/**
 * Every open session view and tracked session holds one stream. A Host serves at most HOST_STREAM_LIMIT;
 * an account holds at most USER_STREAM_LIMIT across all its browsers, devices and Hosts.
 */
export const HOST_STREAM_LIMIT = 128;
export const USER_STREAM_LIMIT = 64;
/** Open views of every browser and device share these limits, so the refusal says what frees a slot. */
export function capacityRefusal(host: boolean) {
  return new Response(JSON.stringify({ code: 'session_stream_capacity', error: host
    ? `This Host has too many sessions open in browsers (limit ${HOST_STREAM_LIMIT}). Close session views you no longer use; this session connects again automatically.`
    : `Too many sessions are open across your browsers and devices (limit ${USER_STREAM_LIMIT}). Close tabs, windows or session views you no longer use; this session connects again automatically.` }),
  { status: 429, headers: { 'content-type': 'application/json' } });
}
