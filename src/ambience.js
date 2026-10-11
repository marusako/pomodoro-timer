// BGM 用の環境音 (雨・波・風・焚き火・心音) を作る。ノイズ (noise.js) と同じく、音声ファイルを使わずに数値の並びとして生成する。
// - seconds 秒の長さを作り、くり返し鳴らす (ループ)。つなぎ目で音が途切れたりプツッと鳴ったりしないように、
//   ゆっくり変わる強さはループの長さでちょうど何回か回る形にし、ザーッという音の部分は終わりを頭に重ねてなじませる
// - random を引数で受け取るのは、テストで毎回同じ結果を出すため

export const AMBIENT_TYPES = Object.freeze(['rain', 'waves', 'wind', 'fire', 'heartbeat']);
export const AMBIENT_SECONDS = 30;

const PEAK = 0.9;
// 種類による聞こえる大きさの差をなくすため、平均の強さ (RMS) をここにそろえる (大きすぎる瞬間は PEAK まで)
const TARGET_RMS = 0.18;
// つなぎ目で重ねる長さ (秒)
const CROSSFADE_SECONDS = 0.5;

// 音量をそろえる: 平均の強さを TARGET_RMS に、いちばん大きい瞬間を PEAK 以下にする
function level(samples) {
  let peak = 0;
  let sum = 0;
  for (const v of samples) {
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  if (peak === 0) return samples;
  const rms = Math.sqrt(sum / samples.length);
  const scale = Math.min(PEAK / peak, TARGET_RMS / rms);
  for (let i = 0; i < samples.length; i += 1) samples[i] *= scale;
  return samples;
}

// ピンクノイズ (高い音ほど弱いザーッという音) を 1 サンプルずつ返す。Paul Kellet の近似式
function pinkSource(random) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return () => {
    const w = random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const out = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    return out;
  };
}

// ブラウンノイズ (低くこもった音) を 1 サンプルずつ返す
function brownSource(random) {
  let last = 0;
  return () => {
    last = (last + 0.02 * (random() * 2 - 1)) / 1.02;
    return last * 3.5;
  };
}

// 高い音を弱める (1 次のローパス)。cutoff (Hz) より高い音ほど弱くなる。
// サンプリング周波数 (パソコンによって 44100 / 48000 など) が違っても、同じ聞こえ方になるように Hz で決める
function lowpass(sampleRate) {
  let y = 0;
  return (x, cutoff) => {
    y += (1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate)) * (x - y);
    return y;
  };
}

// 低い音を弱める (1 次のハイパス)。cutoff (Hz) より低い音ほど弱くなる
function highpass(sampleRate, cutoff) {
  const rc = 1 / (2 * Math.PI * cutoff);
  const a = rc / (rc + 1 / sampleRate);
  let lastX = 0;
  let y = 0;
  return (x) => {
    y = a * (y + x - lastX);
    lastX = x;
    return y;
  };
}

// 0〜1 をゆっくり行き来する強さ。ループの長さの中でちょうど cycles 回まわるので、つなぎ目で途切れない
const cycle = (t, total, cycles, phase = 0) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (cycles * t / total + phase));

// ザーッという音の部分 (bed) を、ループ 1 回分より crossfade だけ長く作り、終わりを頭に重ねてなじませる
function loopedBed(length, crossfade, next) {
  const raw = new Float32Array(length + crossfade);
  for (let i = 0; i < raw.length; i += 1) raw[i] = next(i % length);
  const out = raw.slice(0, length);
  for (let i = 0; i < crossfade; i += 1) {
    // 同じ大きさのまま入れ替わるように (等パワー)
    const k = i / crossfade;
    out[i] = raw[i] * Math.sqrt(k) + raw[length + i] * Math.sqrt(1 - k);
  }
  return out;
}

// 短い音 (雨粒・はぜる音) を、ループの中の at の位置に足す。終わりを越えた分は頭に回す
function addBurst(out, at, burst) {
  for (let i = 0; i < burst.length; i += 1) out[(at + i) % out.length] += burst[i];
}

// 短く減っていくザッという音 (decay 秒で 1/e になる)
function noiseBurst(sampleRate, seconds, decay, amp, random, cutoff) {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const burst = new Float32Array(n);
  const filter = lowpass(sampleRate);
  for (let i = 0; i < n; i += 1) {
    const env = Math.exp(-i / (decay * sampleRate));
    burst[i] = filter((random() * 2 - 1) * env * amp, cutoff);
  }
  return burst;
}

function rain(sampleRate, length, random) {
  const pink = pinkSource(random);
  const hp = highpass(sampleRate, 120);
  const lp = lowpass(sampleRate);
  const total = length;
  const out = loopedBed(length, Math.round(CROSSFADE_SECONDS * sampleRate), (i) => {
    // 強さが少しだけゆらぐ (ループの中で 3 回)
    const swell = 0.85 + 0.15 * cycle(i, total, 3);
    return lp(hp(pink()), 6000) * swell;
  });
  // 雨粒: 1 秒に約 60 粒。小さいものほど多い
  const drops = Math.round((length / sampleRate) * 60);
  for (let d = 0; d < drops; d += 1) {
    const amp = 0.04 + 0.22 * random() ** 3;
    addBurst(out, Math.floor(random() * length), noiseBurst(sampleRate, 0.02, 0.003 + 0.004 * random(), amp, random, 4000));
  }
  return out;
}

function waves(sampleRate, length, random) {
  const brown = brownSource(random);
  const pink = pinkSource(random);
  const lp = lowpass(sampleRate);
  const wash = lowpass(sampleRate);
  const total = length;
  return loopedBed(length, Math.round(CROSSFADE_SECONDS * sampleRate), (i) => {
    // 寄せては返す: ループの中で 4 回 (約 7.5 秒ごと)。寄せるときは速く、返すときはゆっくり
    const swell = cycle(i, total, 4) ** 1.6;
    const env = 0.15 + 0.85 * swell;
    // 寄せきったあとの、泡が引いていくシャーという音 (少し遅れて来る)
    const foam = cycle(i, total, 4, -0.12) ** 3;
    return lp(brown(), 700) * env + wash(pink(), 2500) * foam * 0.6;
  });
}

function wind(sampleRate, length, random) {
  const pink = pinkSource(random);
  const lp1 = lowpass(sampleRate);
  const lp2 = lowpass(sampleRate);
  const total = length;
  return loopedBed(length, Math.round(CROSSFADE_SECONDS * sampleRate), (i) => {
    // 強さが不規則に見えるように、回る回数の違う 2 つの波を重ねる (どちらもループの中でちょうど回る)
    const gust = 0.6 * cycle(i, total, 2) + 0.4 * cycle(i, total, 5, 0.3);
    const env = 0.25 + 0.75 * gust;
    // 強いときほど高い音が混ざる (ヒューという感じ)
    const cutoff = 120 + 600 * gust;
    return lp2(lp1(pink(), cutoff), cutoff * 1.5) * env * 6;
  });
}

function fire(sampleRate, length, random) {
  const brown = brownSource(random);
  const pink = pinkSource(random);
  const lp = lowpass(sampleRate);
  const hiss = lowpass(sampleRate);
  const total = length;
  const out = loopedBed(length, Math.round(CROSSFADE_SECONDS * sampleRate), (i) => {
    // 低いごうごうという音と、かすかなシューという音。炎の強さがゆっくり揺れる
    const flicker = 0.8 + 0.2 * cycle(i, total, 7);
    return (lp(brown(), 350) * 0.9 + hiss(pink(), 3000) * 0.12) * flicker;
  });
  // はぜる音: 1 秒に約 5 回。ときどき続けて何回かはぜる
  const pops = Math.round((length / sampleRate) * 5);
  for (let p = 0; p < pops; p += 1) {
    let at = Math.floor(random() * length);
    const burstCount = random() < 0.25 ? 2 + Math.floor(random() * 4) : 1;
    for (let b = 0; b < burstCount; b += 1) {
      const amp = 0.25 + 0.75 * random() ** 2;
      addBurst(out, at, noiseBurst(sampleRate, 0.012, 0.0008 + 0.0015 * random(), amp, random, 7000));
      at += Math.floor((0.01 + 0.05 * random()) * sampleRate);
    }
  }
  return out;
}

// 心音: 1 分に 60 回。「ドッ (lub)」のあと 0.3 秒で少し小さい「クン (dub)」。乱数は使わない (毎回同じ鼓動)
export const HEARTBEAT_BPM = 60;

function heartbeat(sampleRate, length) {
  const out = new Float32Array(length);
  const period = Math.round((60 / HEARTBEAT_BPM) * sampleRate);
  const thump = (start, freq, amp) => {
    const n = Math.round(0.25 * sampleRate);
    let phase = 0;
    for (let i = 0; i < n; i += 1) {
      const t = i / sampleRate;
      const env = (1 - Math.exp(-t / 0.006)) * Math.exp(-t / 0.06);
      // 打った瞬間は少し高く、すぐ下がる (ドンという感じ)
      phase += (2 * Math.PI * freq * (1 + 0.6 * Math.exp(-t / 0.02))) / sampleRate;
      out[(start + i) % length] += Math.sin(phase) * env * amp;
    }
  };
  for (let start = 0; start < length; start += period) {
    thump(start, 48, 1);
    thump(start + Math.round(0.3 * sampleRate), 62, 0.7);
  }
  return out;
}

const GENERATORS = { rain, waves, wind, fire, heartbeat };

export function generateAmbience(type, sampleRate, seconds = AMBIENT_SECONDS, random = Math.random) {
  if (!AMBIENT_TYPES.includes(type)) throw new Error(`unknown ambience type: ${type}`);
  const length = Math.round(sampleRate * seconds);
  return level(GENERATORS[type](sampleRate, length, random));
}
