/**
 * VN 대화창 애니메이션 WebP 렌더러 — Node 서버 (Docker 호스팅용)
 *
 * 사용법 (마크다운, 인코딩 불필요):
 * ![](https://내도메인/?bg=0&char=U1_0&name=서윤슬&line=대사&color=pink)
 *
 * 쿼리 파라미터
 *  bg        : 배경 코드 → assets/bg/{코드}.png   (예: 0~9, t)
 *  char      : 캐릭터 코드 → assets/char/{코드}.png (예: U1_0, LUZ_0, 나중에 이름_0)
 *  name      : 이름표
 *  line      : 대사 (줄바꿈은 %0A)
 *  color     : red / sky / yellow / pink / gray (한글 빨강/하늘/노랑/핑크/회색도 가능)
 *  anim      : 0 이면 움직임 없는 정지 PNG로 반환 (기본은 애니메이션 WebP)
 *
 * 같은 파라미터 조합은 처음 한 번만 렌더링하고, 이후엔 디스크 캐시에서 바로 응답한다.
 */

const express = require('express');
const sharp = require('sharp');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const PORT = process.env.PORT || 3000;
// 저장소 루트의 bg/, char/ 폴더를 그대로 쓴다
const ASSET_DIR = process.env.ASSET_DIR || __dirname;
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, 'cache');

const W = 1216, H = 832;

// ── 애니메이션 설정 ───────────────────────────
const FRAMES = 20;        // 프레임 수
const FRAME_DELAY = 120;  // 프레임당 ms → 20 × 120 = 2.4초에 한 번 왕복
const FLOAT_PX = 7;       // 위아래로 떠오르는 폭(px)

// ── 캐릭터 배치 (기존 디자인과 동일: 가로 중앙, 아래 정렬) ──
const CHAR_MAX_W = 600;
const CHAR_MAX_H = Math.round(H * 0.9);
const CHAR_BOTTOM = Math.round(H * 0.05 + H * 0.9);

const FONT = "'Noto Sans CJK KR', 'Noto Sans KR', sans-serif";

const COLOR_MAP = {
  red: '#e8615c', '빨강': '#e8615c',
  sky: '#4fc3e8', '하늘': '#4fc3e8',
  yellow: '#f2c14e', '노랑': '#f2c14e',
  pink: '#ef7fa0', '핑크': '#ef7fa0',
  gray: '#9aa3ad', '회색': '#9aa3ad',
};

// 영문/숫자만 허용 → 경로 조작(../) 차단. 파일만 추가하면 새 코드가 바로 동작한다.
const BG_CODE_RE = /^[A-Za-z0-9]+$/;
const CHAR_CODE_RE = /^[A-Za-z0-9]+_[0-9]+$/;

const app = express();
const inFlight = new Map(); // 같은 요청이 동시에 여러 번 와도 한 번만 렌더링

app.get('/', async (req, res) => {
  try {
    const p = parseParams(req.query);
    const ext = p.anim ? 'webp' : 'png';
    // 같은 이름으로 이미지를 교체해도 새로 그리도록 파일 수정시각을 캐시 키에 포함
    const mtimes = await Promise.all([assetMtime('bg', p.bg), assetMtime('char', p.char)]);
    const key = crypto.createHash('sha1').update(JSON.stringify([p, mtimes])).digest('hex');
    const file = path.join(CACHE_DIR, `${key}.${ext}`);

    let buf = await fs.readFile(file).catch(() => null);
    if (!buf) {
      if (!inFlight.has(key)) {
        inFlight.set(key, render(p).then(async (out) => {
          await fs.mkdir(CACHE_DIR, { recursive: true });
          await fs.writeFile(file, out);
          return out;
        }).finally(() => inFlight.delete(key)));
      }
      buf = await inFlight.get(key);
    }

    res.set('Content-Type', p.anim ? 'image/webp' : 'image/png');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).send('render error');
  }
});

app.listen(PORT, () => console.log(`vn-server listening on :${PORT}`));

// ─────────────────────────────────────────────

function parseParams(q) {
  const str = (v, d = '') => (typeof v === 'string' ? v : d);
  const colorKey = str(q.color, 'sky').toLowerCase();
  const bg = str(q.bg);
  const char = str(q.char);
  return {
    bg: BG_CODE_RE.test(bg) ? bg : '',
    char: CHAR_CODE_RE.test(char) ? char : '',
    name: str(q.name, '이름').slice(0, 20),
    line: str(q.line).slice(0, 200),
    color: COLOR_MAP[colorKey] || COLOR_MAP.sky,
    anim: str(q.anim) !== '0',
  };
}

async function assetMtime(sub, code) {
  if (!code) return 0;
  const st = await fs.stat(path.join(ASSET_DIR, sub, `${code}.png`)).catch(() => null);
  return st ? st.mtimeMs : 0;
}

async function loadAsset(sub, code) {
  if (!code) return null;
  return fs.readFile(path.join(ASSET_DIR, sub, `${code}.png`)).catch(() => null);
}

// 배경·캐릭터는 크기 조정한 결과(raw 픽셀)를 메모리에 보관해 재사용한다
const layerCache = new Map();
async function cachedLayer(key, make) {
  if (!layerCache.has(key)) {
    if (layerCache.size > 200) layerCache.delete(layerCache.keys().next().value);
    layerCache.set(key, make());
  }
  return layerCache.get(key);
}

// 모서리를 둥글게 깎을 픽셀 목록 (한 번만 계산)
let cornerPixels = null;
async function getCornerPixels() {
  if (!cornerPixels) {
    const m = await sharp(Buffer.from(roundMaskSvg())).ensureAlpha().raw().toBuffer();
    cornerPixels = [];
    for (let i = 3; i < m.length; i += 4) if (m[i] < 255) cornerPixels.push(i, m[i]);
  }
  return cornerPixels;
}

async function render(p) {
  const [bgMt, charMt] = await Promise.all([assetMtime('bg', p.bg), assetMtime('char', p.char)]);

  // 1) 바탕: 배경 + 하단 비네트
  const base = await cachedLayer(`bg:${p.bg}:${bgMt}`, async () => {
    const bgBuf = await loadAsset('bg', p.bg);
    const layer = bgBuf
      ? await sharp(bgBuf).resize(W, H, { fit: 'cover' }).png().toBuffer()
      : Buffer.from(defaultSkySvg());
    return sharp(layer)
      .composite([{ input: Buffer.from(vignetteSvg()), top: 0, left: 0 }])
      .ensureAlpha().raw().toBuffer();
  });

  // 2) 캐릭터
  const char = p.char ? await cachedLayer(`char:${p.char}:${charMt}`, async () => {
    const buf = await loadAsset('char', p.char);
    if (!buf) return null;
    const { data, info } = await sharp(buf)
      .resize(CHAR_MAX_W, CHAR_MAX_H, { fit: 'inside' })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, w: info.width, h: info.height };
  }) : null;

  // 3) UI(대화창·버튼): 대사마다 다르므로 매번 그린다
  const ui = await sharp(Buffer.from(uiSvg(p))).ensureAlpha().raw().toBuffer();
  const corners = await getCornerPixels();

  const FRAME_BYTES = W * H * 4;
  const drawFrame = (target, offsetY) => {
    base.copy(target);
    if (char) blend(target, char.data, char.w, char.h, Math.round((W - char.w) / 2), CHAR_BOTTOM - char.h + offsetY);
    blend(target, ui, W, H, 0, 0);
    for (let k = 0; k < corners.length; k += 2) target[corners[k]] = corners[k + 1];
  };

  // 정지 이미지 요청이거나 캐릭터가 없으면 한 장만
  if (!p.anim || !char) {
    const one = Buffer.alloc(FRAME_BYTES);
    drawFrame(one, 0);
    const img = sharp(one, { raw: { width: W, height: H, channels: 4 } });
    return p.anim ? img.webp({ quality: 85 }).toBuffer() : img.png().toBuffer();
  }

  // 4) 프레임들을 세로로 이어 붙인 뒤 한 번에 애니메이션 WebP로 인코딩
  const strip = Buffer.alloc(FRAME_BYTES * FRAMES);
  for (let i = 0; i < FRAMES; i++) {
    const offset = Math.round(-FLOAT_PX * Math.sin((2 * Math.PI * i) / FRAMES));
    drawFrame(strip.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES), offset);
  }
  return sharp(strip, { raw: { width: W, height: H * FRAMES, channels: 4, pageHeight: H } })
    .webp({ quality: 75, effort: 2, loop: 0, delay: Array(FRAMES).fill(FRAME_DELAY) })
    .toBuffer();
}

// src(RGBA)를 dst(RGBA, W×H)의 (ox, oy)에 알파 합성
function blend(dst, src, sw, sh, ox, oy) {
  const x0 = Math.max(0, -ox), x1 = Math.min(sw, W - ox);
  const y0 = Math.max(0, -oy), y1 = Math.min(sh, H - oy);
  for (let y = y0; y < y1; y++) {
    let s = (y * sw + x0) * 4;
    let d = ((oy + y) * W + ox + x0) * 4;
    for (let x = x0; x < x1; x++, s += 4, d += 4) {
      const a = src[s + 3];
      if (a === 0) continue;
      if (a === 255) { dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; continue; }
      const ia = 255 - a;
      dst[d] = (src[s] * a + dst[d] * ia) / 255;
      dst[d + 1] = (src[s + 1] * a + dst[d + 1] * ia) / 255;
      dst[d + 2] = (src[s + 2] * a + dst[d + 2] * ia) / 255;
    }
  }
}

// ── SVG 조각들 ────────────────────────────────

function defaultSkySvg() {
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#bfe4f7"/><stop offset="55%" stop-color="#8fc9ea"/><stop offset="100%" stop-color="#d7ecf7"/>
  </linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/></svg>`;
}

function vignetteSvg() {
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.28"/>
  </linearGradient></defs>
  <rect x="0" y="${H - 300}" width="${W}" height="300" fill="url(#f)"/></svg>`;
}

function roundMaskSvg() {
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" rx="14" fill="#fff"/></svg>`;
}

function uiSvg({ name, line, color }) {
  const initial = escapeXml(name.trim()[0] || '?');
  const lines = wrapText(line, 18);
  const lineSvg = lines
    .map((l, i) => `<tspan x="34" dy="${i === 0 ? 0 : 46}">${escapeXml(l)}</tspan>`)
    .join('');

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <!-- 우상단 아이콘 (장식) -->
  <g transform="translate(${W - 24 - 176}, 24)">
    <circle cx="17" cy="17" r="17" fill="#1a1f2b" fill-opacity="0.45"/>
    <rect x="10" y="11" width="14" height="2.4" rx="1.2" fill="#fff"/>
    <rect x="10" y="16" width="14" height="2.4" rx="1.2" fill="#fff"/>
    <rect x="10" y="21" width="14" height="2.4" rx="1.2" fill="#fff"/>
    <g transform="translate(44,0)">
      <circle cx="17" cy="17" r="17" fill="#1a1f2b" fill-opacity="0.45"/>
      <rect x="10" y="10" width="14" height="2" rx="1" fill="#fff"/>
      <rect x="10" y="16" width="14" height="2" rx="1" fill="#fff"/>
      <rect x="10" y="22" width="9" height="2" rx="1" fill="#fff"/>
    </g>
    <g transform="translate(88,0)">
      <circle cx="17" cy="17" r="17" fill="${color}" fill-opacity="0.85"/>
      <text x="17" y="21" font-family="${FONT}" font-size="10" font-weight="800" fill="#fff" text-anchor="middle">AUTO</text>
    </g>
    <g transform="translate(132,0)">
      <circle cx="17" cy="17" r="17" fill="#1a1f2b" fill-opacity="0.45"/>
      <path d="M10 10 v14 l9 -7z" fill="#fff"/><path d="M19 10 v14 l9 -7z" fill="#fff"/>
    </g>
  </g>

  <!-- 대화창 -->
  <g transform="translate(24, ${H - 24 - 248})">
    <rect width="${W - 48}" height="248" rx="18" fill="#fbfcfe" stroke="${color}" stroke-width="3"/>
    <path d="M${W - 78} 0 h30 v30 z" fill="${color}"/>
    <rect x="14" y="14" width="10" height="10" fill="${color}" opacity="0.5" transform="rotate(45 19 19)"/>
    <circle cx="42" cy="-9" r="24" fill="#fff" stroke="${color}" stroke-width="3"/>
    <text x="42" y="-2" font-family="${FONT}" font-size="19" font-weight="800" fill="${color}" text-anchor="middle">${initial}</text>
    <rect x="74" y="-30" width="${48 + name.length * 21}" height="44" rx="11" fill="${color}"/>
    <text x="98" y="-1" font-family="${FONT}" font-size="21" font-weight="700" fill="#fff">${escapeXml(name)}</text>
    <text x="0" y="66" font-family="${FONT}" font-size="26" font-weight="500" fill="#384049">${lineSvg}</text>
    <g transform="translate(${W - 258}, 210)">
      <rect width="70" height="30" rx="15" fill="${color}" opacity="0.14"/>
      <text x="35" y="20" font-family="${FONT}" font-size="12" font-weight="700" fill="${color}" text-anchor="middle">AUTO</text>
      <rect x="80" width="70" height="30" rx="15" fill="${color}" opacity="0.14"/>
      <text x="115" y="20" font-family="${FONT}" font-size="12" font-weight="700" fill="${color}" text-anchor="middle">SKIP</text>
      <g transform="translate(176,15)">
        <circle cy="-7" r="3.4" fill="${color}"/>
        <path d="M-5.5 1 l5.5 6.5 l5.5 -6.5" stroke="${color}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
      </g>
    </g>
  </g>
</svg>`;
}

// ── 유틸 ──────────────────────────────────────

function clamp(n, min, max) {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// %0A(줄바꿈)로 직접 끊은 곳은 그대로 지키고, 긴 줄은 글자수 기준으로 자동 줄바꿈
function wrapText(text, max) {
  if (!text) return [''];
  const out = [];
  for (const para of text.split(/\r?\n/)) {
    let cur = '';
    for (const word of para.split(' ')) {
      const cand = cur ? `${cur} ${word}` : word;
      if (cand.length <= max) { cur = cand; continue; }
      if (cur) out.push(cur);
      let rest = word;
      while (rest.length > max) { out.push(rest.slice(0, max)); rest = rest.slice(max); }
      cur = rest;
    }
    out.push(cur);
  }
  return out;
}
