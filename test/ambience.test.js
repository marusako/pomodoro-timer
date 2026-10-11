import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AMBIENT_TYPES, AMBIENT_SECONDS, HEARTBEAT_BPM, generateAmbience } from '../src/ambience.js';

// テストで毎回同じ結果になるよう、決まった順に値を返す疑似乱数を使う
function seeded(seed = 1) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

// テストを速くするため、低いサンプリング周波数・短い長さで作る
const RATE = 8000;
const SECONDS = 6;
const make = (type) => generateAmbience(type, RATE, SECONDS, seeded());
const rms = (s) => Math.sqrt(s.reduce((sum, v) => sum + v * v, 0) / s.length);

test('環境音は 雨・波・風・焚き火・心音 の 5 種類。初めは 30 秒をくり返す', () => {
  assert.deepEqual(AMBIENT_TYPES, ['rain', 'waves', 'wind', 'fire', 'heartbeat']);
  assert.equal(AMBIENT_SECONDS, 30);
});

test('指定した長さで、値は -1〜1 に収まり、無音ではない。種類による音の大きさの差は小さい', () => {
  const levels = [];
  for (const type of AMBIENT_TYPES) {
    const samples = make(type);
    assert.equal(samples.length, RATE * SECONDS);
    assert.ok(samples.every((v) => Number.isFinite(v) && v >= -0.95 && v <= 0.95), `${type} の値が範囲外`);
    levels.push(rms(samples));
  }
  for (const [i, value] of levels.entries()) assert.ok(value > 0.05, `${AMBIENT_TYPES[i]} の音が小さすぎる (${value})`);
  // 心音は音のない時間が長いので除き、ほかの 4 つの平均の強さがそろっているか
  const beds = levels.slice(0, 4);
  assert.ok(Math.max(...beds) / Math.min(...beds) < 1.5, `大きさの差が大きい ${beds}`);
});

test('同じ乱数なら同じ音になる', () => {
  for (const type of AMBIENT_TYPES) assert.deepEqual(make(type), make(type), type);
});

test('つなぎ目 (最後のサンプル → 最初のサンプル) で、ふだんより大きく飛ばない (プツッと鳴らない)', () => {
  for (const type of AMBIENT_TYPES) {
    const s = make(type);
    const diffs = [];
    for (let i = 1; i < s.length; i += 1) diffs.push(Math.abs(s[i] - s[i - 1]));
    diffs.sort((a, b) => a - b);
    const p999 = diffs[Math.floor(diffs.length * 0.999)];
    const wrap = Math.abs(s[0] - s[s.length - 1]);
    assert.ok(wrap <= p999, `${type}: つなぎ目の差 ${wrap} > ふだんの 99.9% ${p999}`);
  }
});

test('心音は 1 分に 60 回。毎秒の頭に強い音がある', () => {
  assert.equal(HEARTBEAT_BPM, 60);
  const s = make('heartbeat');
  const window = (from, to) => rms(s.slice(Math.round(from * RATE), Math.round(to * RATE)));
  for (let sec = 0; sec < SECONDS; sec += 1) {
    assert.ok(window(sec, sec + 0.15) > window(sec + 0.6, sec + 0.95) * 5, `${sec} 秒目の鼓動が弱い`);
  }
});

test('知らない種類はエラーにする', () => {
  assert.throws(() => generateAmbience('birds', RATE, 1, seeded()));
});
