// 音の再生 (画面側)。アラーム・SE は Web Audio API でその場で音を作り、
// BGM はノイズ (noise.js で生成) か、取り込んだ音声ファイルをループ再生する。
import { generateNoise } from './noise.js';
import { AMBIENT_TYPES, AMBIENT_SECONDS, generateAmbience } from './ambience.js';
import { alarmNotes } from './alarms.js';
import { seNotes } from './se-sounds.js';

const NOISE_SECONDS = 10; // ノイズはこの長さを作ってループする
const FADE_SECONDS = 0.4; // BGM の出だしと止めるときに、急に鳴る・切れるのを防ぐ

let audioContext = null;

// AudioContext は 1 つを使い回す (鳴らすたびに作ると、端末の音声の資源を消費し続ける)
function context() {
  audioContext ??= new AudioContext();
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

function level(volume, max) {
  return max * (Math.min(100, Math.max(0, volume)) / 100);
}

// 楽譜 (alarms.js・se-sounds.js の音の一覧) のとおりに、音を 1 つずつ予約して鳴らす。peak は gain 1 の音の大きさ。
// 出だしを attack の間だけゆるやかにするのは、いきなり鳴らすと「プツッ」という雑音が出るため
function playNotes(notes, peak) {
  const ctx = context();
  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const at = ctx.currentTime + note.at;
    osc.type = note.wave;
    osc.frequency.setValueAtTime(note.freq, at);
    // 途中で高さを変える音は、glide 秒かけて freqEnd へ移す
    if (note.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(note.freqEnd, at + note.glide);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak * note.gain, at + note.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + note.duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + note.duration + 0.05);
  }
}

// セッション終了の音 (soundId は alarms.js の ALARM_SOUNDS)
export function playAlarm(volume, soundId) {
  if (volume <= 0) return;
  playNotes(alarmNotes(soundId), level(volume, 0.3));
}

// ボタンを押したときの音 (soundId は se-sounds.js の SE_SOUNDS)
export function playClick(volume, soundId) {
  if (volume <= 0) return;
  playNotes(seNotes(soundId), level(volume, 0.35));
}

// BGM の再生。source は 'none' / 'noise:<種類>' / 'import:<保存名>'。
// resolveUrl は取り込んだファイルの保存名から読み込み用の URL を作る関数。
// createAudio は再生の部品 (Audio) を作る関数で、テストでは偽物に差し替える。
// onEnded は取り込んだ曲が最後まで再生されたときに呼ぶ関数 (次にどの曲を流すかは、呼んだ側が playlist.js で決める)。
// 取り込んだ曲は、止めても部品と再生位置を残し、再開したら続きから再生する (手放すのは曲を変えたときだけ)
export class BgmPlayer {
  #resolveUrl;
  #createAudio;
  #onEnded;
  #source = 'none';
  #volume = 0;
  #playing = false;
  #noiseBuffers = new Map();
  #noiseNode = null;
  #gain = null;
  #element = null;
  #previewTimer = null;

  constructor(resolveUrl, { createAudio = (url) => new Audio(url), onEnded = () => {} } = {}) {
    this.#resolveUrl = resolveUrl;
    this.#createAudio = createAudio;
    this.#onEnded = onEnded;
  }

  // 今鳴っているか (曲が最後まで終わったあと、次の曲を決めるまでの間も true のまま)
  get playing() {
    return this.#playing;
  }

  // 取り込んだ曲の今の位置と長さ (秒)。ノイズや、まだ曲を読み込んでいないときは null
  position() {
    if (!this.#element) return null;
    return { current: this.#element.currentTime, duration: this.#element.duration };
  }

  seek(seconds) {
    if (this.#element) this.#element.currentTime = seconds;
  }

  // 今の曲を最初から (リピート「1 曲」や、前へボタンで使う)。鳴らしている途中なら、そのまま鳴らし続ける
  restart() {
    if (!this.#element) return;
    this.#element.currentTime = 0;
    if (this.#playing) this.#element.play().catch((error) => console.error('[bgm] play failed', error));
  }

  setVolume(volume) {
    this.#volume = volume;
    if (this.#gain) this.#gain.gain.setTargetAtTime(level(volume, 0.5), context().currentTime, 0.05);
    if (this.#element) this.#element.volume = level(volume, 1);
  }

  setSource(source) {
    if (source === this.#source) return;
    const wasPlaying = this.#playing;
    this.#stop(false);
    this.#releaseFile();
    this.#source = source;
    if (wasPlaying) this.#start();
  }

  // shouldPlay が変わったときだけ再生・停止する (毎回呼ばれても問題ない)
  sync(shouldPlay) {
    if (this.#previewTimer) return; // 試聴中はタイマーの状態で止めない
    if (shouldPlay && !this.#playing) this.#start();
    if (!shouldPlay && this.#playing) this.#stop(true);
  }

  // 設定画面の「Test」用。数秒だけ鳴らして止める
  preview(milliseconds = 3000) {
    clearTimeout(this.#previewTimer);
    if (!this.#playing) this.#start();
    this.#previewTimer = setTimeout(() => {
      this.#previewTimer = null;
      this.#stop(true);
    }, milliseconds);
  }

  #start() {
    const [kind, value] = this.#source.split(':');
    if (kind === 'noise') this.#startNoise(value);
    else if (kind === 'import') this.#startFile(value);
    else return;
    this.#playing = true;
  }

  #startNoise(type) {
    const ctx = context();
    if (!this.#noiseBuffers.has(type)) {
      // 環境音 (雨・波など) は 30 秒、ノイズは 10 秒を作ってくり返す
      const samples = AMBIENT_TYPES.includes(type)
        ? generateAmbience(type, ctx.sampleRate, AMBIENT_SECONDS)
        : generateNoise(type, ctx.sampleRate * NOISE_SECONDS);
      const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.copyToChannel(samples, 0);
      this.#noiseBuffers.set(type, buffer);
    }
    this.#noiseNode = ctx.createBufferSource();
    this.#noiseNode.buffer = this.#noiseBuffers.get(type);
    this.#noiseNode.loop = true;
    this.#gain = ctx.createGain();
    this.#gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    this.#gain.gain.linearRampToValueAtTime(level(this.#volume, 0.5), ctx.currentTime + FADE_SECONDS);
    this.#noiseNode.connect(this.#gain).connect(ctx.destination);
    this.#noiseNode.start();
  }

  #startFile(storedName) {
    // 一時停止していた部品が残っていれば、それを使って止めた位置から続ける
    if (!this.#element) {
      this.#element = this.#createAudio(this.#resolveUrl(storedName));
      // 1 曲で繰り返さず、終わったら知らせて次の曲を決めてもらう
      this.#element.loop = false;
      this.#element.addEventListener('ended', () => this.#onEnded());
    }
    this.#element.volume = level(this.#volume, 1);
    this.#element.play().catch((error) => console.error('[bgm] play failed', error));
  }

  // 曲を変えたときに、前の曲の部品と読み込み中のファイルを手放す
  #releaseFile() {
    if (!this.#element) return;
    this.#element.pause();
    this.#element.removeAttribute('src');
    this.#element.load();
    this.#element = null;
  }

  #stop(fade) {
    clearTimeout(this.#previewTimer);
    this.#previewTimer = null;
    if (this.#noiseNode) {
      const node = this.#noiseNode;
      const ctx = context();
      const end = ctx.currentTime + (fade ? FADE_SECONDS : 0.01);
      this.#gain.gain.cancelScheduledValues(ctx.currentTime);
      this.#gain.gain.setValueAtTime(this.#gain.gain.value, ctx.currentTime);
      this.#gain.gain.linearRampToValueAtTime(0.0001, end);
      node.stop(end + 0.05);
      this.#noiseNode = null;
      this.#gain = null;
    }
    // 取り込んだ曲は一時停止だけにして、再生位置を残す
    if (this.#element) this.#element.pause();
    this.#playing = false;
  }
}
