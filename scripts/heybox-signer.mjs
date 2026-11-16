// HeyBox (小黑盒) Web 请求签名。
// 算法移植自公开项目 foxlesbiao/xiaoheihe-mcp 的 xiaoheihe_mcp/signer.py
// (MIT License, https://github.com/foxlesbiao/xiaoheihe-mcp)。
// 原文件注释: "小黑盒 Web 请求签名，算法来自公开的非官方接口研究。"
// 本文件仅做等价 transliteration，未做任何"简化":时间戳 +1、负数切片、
// "15:" 前缀与版本号均与原实现一致。签名常量为算法公开常量,非账号凭证;
// 请求全程不登录 (heybox_id=0, 无 Cookie)。
import { createHash, createHmac, randomInt } from 'node:crypto';

const R_CHARSET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';
const RND_KEY = 'Z7mFG4tQp9Ws2LxB8H';
const NONCE_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const VERSION = '999.0.4';

function tw(s, charset, n) {
  const sub = charset.slice(0, n);
  let out = '';
  for (const ch of s) out += sub[ch.codePointAt(0) % sub.length];
  return out;
}

function rw(s, charset) {
  let out = '';
  for (const ch of s) out += charset[ch.codePointAt(0) % charset.length];
  return out;
}

function interleave(values) {
  const maxLen = Math.max(...values.map((v) => v.length));
  let out = '';
  for (let i = 0; i < maxLen; i++) {
    for (const v of values) if (i < v.length) out += v[i];
  }
  return out;
}

function ty(value) {
  return value & 128 ? ((value << 1) ^ 27) & 255 : value << 1;
}
function da(value) {
  return ty(value) ^ value;
}
function vs(value) {
  return da(ty(value));
}
function dolC(value) {
  return vs(da(ty(value)));
}
function dl(value) {
  return dolC(value) ^ vs(value) ^ da(value);
}

function mixColumns(values) {
  const result = [
    dl(values[0]) ^ dolC(values[1]) ^ vs(values[2]) ^ da(values[3]),
    da(values[0]) ^ dl(values[1]) ^ dolC(values[2]) ^ vs(values[3]),
    vs(values[0]) ^ da(values[1]) ^ dl(values[2]) ^ dolC(values[3]),
    dolC(values[0]) ^ vs(values[1]) ^ da(values[2]) ^ dl(values[3]),
  ];
  values.splice(0, 4, ...result);
  return values;
}

export function cleanPath(path) {
  return '/' + path.split('/').filter(Boolean).join('/') + '/';
}

export function calcHkey(path, timestamp, nonce) {
  const normalized = cleanPath(path);
  const partTime = tw(String(timestamp + 1), R_CHARSET, -2);
  const partPath = rw(normalized, R_CHARSET);
  const partNonce = rw(nonce, R_CHARSET);
  const digest = createHash('md5')
    .update(interleave([partTime, partPath, partNonce]).slice(0, 20), 'utf8')
    .digest('hex');
  const transformed = mixColumns([...digest.slice(-6)].map((c) => c.codePointAt(0)));
  const upper = String(transformed.reduce((a, b) => a + b, 0) % 100).padStart(2, '0');
  const lower = tw(digest.slice(0, 5), R_CHARSET, -4);
  return lower + upper;
}

export function calcRnd(nonce, timestamp) {
  const message = RND_KEY + nonce + `${timestamp}:${nonce}`;
  return '15:' + createHmac('sha256', RND_KEY).update(message, 'utf8').digest('hex');
}

export function signWebRequest(path, timestamp, nonce) {
  const now = Math.floor(timestamp ?? Date.now() / 1000);
  const n =
    nonce ??
    Array.from({ length: 32 }, () => NONCE_CHARS[randomInt(NONCE_CHARS.length)]).join('');
  return {
    _time: String(now),
    nonce: n,
    hkey: calcHkey(path, now, n),
    _rnd: calcRnd(n, now),
    version: VERSION,
  };
}
