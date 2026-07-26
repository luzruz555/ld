/**
 * VN 대화창 PNG 렌더러 — Cloudflare Worker (resvg-wasm으로 실제 PNG 래스터화)
 *
 * 이미지는 GitHub 저장소에 아래 구조로 올려두고, 짧은 코드로 참조합니다.
 *   /bg/0.png ~ /bg/9.png            (배경 10종, 1216x832 권장, 꽉 채우는 그림)
 *   /char/U1_0.png ~ U1_4.png        (캐릭터 U1의 표정 0~4, 배경 투명 PNG 누끼)
 *   /char/U2_0.png ~ U5_4.png        (U2~U5 동일 규칙)
 *   /fonts/NotoSansKR-Regular.ttf    (한글 렌더링용 폰트, 아래 안내 참고)
 *
 * ※ resvg-wasm은 SVG 안의 <image href="원격URL">을 직접 못 불러옵니다
 *   (브라우저가 아니라 서버에서 그림을 굽는 방식이라 네트워크 접근이 제한됨).
 *   그래서 배경/캐릭터 이미지는 워커가 미리 fetch해서 base64로 SVG에 박아 넣습니다.
 *   (첫 요청 이후엔 Cache API에 캐시되어 그다음부턴 빠릅니다.)
 *
 * 사용법 (마크다운 예시):
 * ![](https://YOUR-WORKER.workers.dev/?bg=3&char=U1_2&name=서윤슬&line=대사내용&affection=65&color=pink)
 *
 * 쿼리 파라미터
 *  bg         : 0~9 숫자 (배경 코드, 없으면 기본 그라데이션)
 *  char       : U1_0 ~ U5_4 형식 (캐릭터_표정 코드, 없으면 표시 안 함)
 *  name       : 이름표 텍스트 (기본 "이름")
 *  line       : 대사 텍스트 (기본 빈 문자열)
 *  affection  : 0~100 숫자 (기본 35)
 *  color      : red / sky / yellow / pink / gray  중 하나 (한글 "빨강/하늘/노랑/핑크/회색"도 가능, 기본 sky)
 *
 * 배포 방법: README.md 참고 (Workers Builds로 깃허브 push시 자동배포)
 */

import { Resvg, initWasm } from '@resvg/resvg-wasm';
// wrangler가 빌드 시점에 이 wasm 파일을 정적으로 번들링함 (동적 로드 불가)
import RESVG_WASM from '@resvg/resvg-wasm/index_bg.wasm';

// ⚠️ 여기를 본인 GitHub 저장소 raw 경로로 교체하세요
const GITHUB_BASE = 'https://raw.githubusercontent.com/luzruz555/ld/main';

const BG_CODE_RE = /^[0-9]$/;
const CHAR_CODE_RE = /^U[1-5]_[0-4]$/;

const COLOR_MAP = {
  red: '#e8615c', '빨강': '#e8615c',
  sky: '#4fc3e8', '하늘': '#4fc3e8',
  yellow: '#f2c14e', '노랑': '#f2c14e',
  pink: '#ef7fa0', '핑크': '#ef7fa0',
  gray: '#9aa3ad', '회색': '#9aa3ad',
};

/**
 * PNG 출력을 위해 resvg-wasm으로 SVG를 실제 래스터화합니다.
 * 한글 렌더링을 위해 폰트 파일을 저장소에서 fetch해서 사용합니다.
 *
 * 폰트 설정 방법 (최초 1회만)
 *  1) Noto Sans KR Regular.ttf 를 구글 폰트에서 받는다.
 *     https://fonts.google.com/noto/specimen/Noto+Sans+KR
 *  2) 깃허브 저장소 루트에 fonts 폴더를 만들고 그 안에
 *     NotoSansKR-Regular.ttf 라는 이름으로 넣는다.
 *  3) 그러면 아래 FONT_URL 이 자동으로 그 파일을 가리킴 (수정 불필요, GITHUB_BASE 재사용)
 */
const FONT_URL = `${GITHUB_BASE}/fonts/NotoSansKR-Regular.ttf`;

let wasmInitPromise = null;
let fontPromise = null;

async function ensureWasm() {
  if (!wasmInitPromise) {
    // 정적 import이므로 wrangler가 빌드 시점에 wasm을 미리 컴파일해둠
    wasmInitPromise = initWasm(RESVG_WASM);
  }
  await wasmInitPromise;
}

async function getFontBuffer() {
  if (fontPromise) return fontPromise;

  fontPromise = (async () => {
    const cache = caches.default;
    const cacheKey = new Request(FONT_URL);
    let res = await cache.match(cacheKey);

    if (!res) {
      res = await fetch(FONT_URL);
      if (res.ok) {
        const toCache = res.clone();
        const headers = new Headers(toCache.headers);
        headers.set('Cache-Control', 'public, max-age=2592000'); // 30일
        // waitUntil 없이도 await로 처리 (요청 흐름 내에서 캐시 저장)
        await cache.put(cacheKey, new Response(toCache.body, { headers }));
      }
    }

    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  })();

  return fontPromise;
}

async function fetchAndCacheBinary(url) {
  const cache = caches.default;
  const cacheKey = new Request(url);
  let res = await cache.match(cacheKey);

  if (!res) {
    res = await fetch(url);
    if (res.ok) {
      const toCache = res.clone();
      const headers = new Headers(toCache.headers);
      headers.set('Cache-Control', 'public, max-age=2592000'); // 30일
      await cache.put(cacheKey, new Response(toCache.body, { headers }));
    }
  }

  if (!res.ok) return null;
  return res.arrayBuffer();
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function toDataUri(url) {
  if (!url) return '';
  const buf = await fetchAndCacheBinary(url);
  if (!buf) return '';
  return `data:image/png;base64,${arrayBufferToBase64(buf)}`;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const params = url.searchParams;

    const bgCode = params.get('bg') || '';
    const charCode = params.get('char') || '';
    const name = params.get('name') || '이름';
    const line = params.get('line') || '';
    const affection = clamp(parseInt(params.get('affection') || '35', 10), 0, 100);
    const colorKey = (params.get('color') || 'sky').toLowerCase();
    const color = COLOR_MAP[colorKey] || COLOR_MAP.sky;

    const bgUrl = BG_CODE_RE.test(bgCode) ? `${GITHUB_BASE}/bg/${bgCode}.png` : '';
    const charUrl = CHAR_CODE_RE.test(charCode) ? `${GITHUB_BASE}/char/${charCode}.png` : '';

    await ensureWasm();

    // resvg는 <image href="원격URL">을 직접 못 불러오므로,
    // 미리 fetch해서 base64 데이터URI로 만들어 SVG에 박아 넣는다.
    const [bg, char, fontBuffer] = await Promise.all([
      toDataUri(bgUrl),
      toDataUri(charUrl),
      getFontBuffer(),
    ]);

    const svg = buildSvg({ bg, char, name, line, affection, color });

    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: 1216 },
      font: fontBuffer
        ? {
            fontBuffers: [fontBuffer],
            defaultFontFamily: 'Noto Sans KR',
            sansSerifFamily: 'Noto Sans KR',
          }
        : { loadSystemFonts: false },
    });

    const pngBuffer = resvg.render().asPng();

    return new Response(pngBuffer, {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=3600',
      },
    });
  },
};

function buildSvg({ bg, char, name, line, affection, color }) {
  const W = 1216, H = 832;
  const level = Math.floor(affection / 20) + 1; // 1~5

  const dialogueLines = wrapText(line, 18);
  const dialogueTextSvg = dialogueLines
    .map((l, i) => `<tspan x="34" dy="${i === 0 ? 0 : 46}">${escapeXml(l)}</tspan>`)
    .join('');

  const affectionRatio = affection / 100;
  const barW = 175;
  const initial = escapeXml((name.trim()[0] || '?'));

  return `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="skyDefault" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#bfe4f7"/>
      <stop offset="55%" stop-color="#8fc9ea"/>
      <stop offset="100%" stop-color="#d7ecf7"/>
    </linearGradient>
    <linearGradient id="dialogueFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.28"/>
    </linearGradient>
    <clipPath id="stageClip">
      <rect x="0" y="0" width="${W}" height="${H}" rx="14"/>
    </clipPath>
  </defs>

  <g clip-path="url(#stageClip)">
    <!-- 배경 -->
    ${bg
      ? `<image href="${escapeXml(bg)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`
      : `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#skyDefault)"/>`
    }

    <!-- 하단 비네트 (대화창 배경 대비용) -->
    <rect x="0" y="${H - 300}" width="${W}" height="300" fill="url(#dialogueFade)"/>

    <!-- 캐릭터 -->
    ${char
      ? `<image href="${escapeXml(char)}" x="${(W - 600) / 2}" y="${H * 0.05}" width="600" height="${H * 0.9}" preserveAspectRatio="xMidYMax meet"/>`
      : ''
    }

    <!-- 좌상단 호감도 바 -->
    <g transform="translate(24,24)">
      <rect x="0" y="0" width="324" height="68" rx="34" fill="#ffffff" fill-opacity="0.88"/>
      <!-- 레벨 배지 -->
      <circle cx="34" cy="34" r="21" fill="#ffffff" stroke="${color}" stroke-width="3"/>
      <text x="34" y="40" font-family="'Noto Sans KR', sans-serif" font-size="15" font-weight="800" fill="${color}" text-anchor="middle">Lv${level}</text>
      <!-- 하트 아이콘 -->
      <circle cx="82" cy="34" r="17" fill="${color}"/>
      <path d="M82 44 c-10.2 -6.4 -15.2 -12.7 -15.2 -19 c0 -5 3.8 -8.9 8.3 -8.9 c3.1 0 5.6 1.7 7 4.2 c1.3 -2.5 3.8 -4.2 7 -4.2 c4.4 0 8.3 3.9 8.3 8.9 c0 6.3 -5 12.7 -15.2 19z"
        fill="#ffffff" transform="translate(0,-5.4) scale(0.62) translate(0,14.5)" />
      <!-- 반짝임 장식 -->
      <path d="M107 14 l2.6 6.6 l6.6 2.6 l-6.6 2.6 l-2.6 6.6 l-2.6 -6.6 l-6.6 -2.6 l6.6 -2.6z" fill="${color}" opacity="0.85"/>
      <text x="126" y="26" font-family="'Noto Sans KR', sans-serif" font-size="13" font-weight="700" fill="#97a0ab">호감도 <tspan fill="#384049" font-size="16">${affection}</tspan></text>
      <rect x="126" y="36" width="${barW}" height="11" rx="5.5" fill="#eef2f7"/>
      <rect x="126" y="36" width="${(barW * affectionRatio).toFixed(1)}" height="11" rx="5.5" fill="${color}"/>
    </g>

    <!-- 우상단 아이콘 4종 (장식용, 작동 안 함) -->
    <g transform="translate(${W - 24 - 4 * 44}, 24)">
      <!-- 메뉴 -->
      <g>
        <circle cx="17" cy="17" r="17" fill="#1a1f2b" fill-opacity="0.45"/>
        <rect x="10" y="11" width="14" height="2.4" rx="1.2" fill="#fff"/>
        <rect x="10" y="16" width="14" height="2.4" rx="1.2" fill="#fff"/>
        <rect x="10" y="21" width="14" height="2.4" rx="1.2" fill="#fff"/>
      </g>
      <!-- 기록 -->
      <g transform="translate(44,0)">
        <circle cx="17" cy="17" r="17" fill="#1a1f2b" fill-opacity="0.45"/>
        <rect x="10" y="10" width="14" height="2" rx="1" fill="#fff"/>
        <rect x="10" y="16" width="14" height="2" rx="1" fill="#fff"/>
        <rect x="10" y="22" width="9" height="2" rx="1" fill="#fff"/>
      </g>
      <!-- 오토 -->
      <g transform="translate(88,0)">
        <circle cx="17" cy="17" r="17" fill="${color}" fill-opacity="0.85"/>
        <text x="17" y="21" font-family="'Noto Sans KR', sans-serif" font-size="11" font-weight="800" fill="#fff" text-anchor="middle">AUTO</text>
      </g>
      <!-- 빨리감기 -->
      <g transform="translate(132,0)">
        <circle cx="17" cy="17" r="17" fill="#1a1f2b" fill-opacity="0.45"/>
        <path d="M10 10 v14 l9 -7z" fill="#fff"/>
        <path d="M19 10 v14 l9 -7z" fill="#fff"/>
      </g>
    </g>

    <!-- 대화창 -->
    <g transform="translate(24, ${H - 24 - 248})">
      <rect x="0" y="0" width="${W - 48}" height="248" rx="18" fill="#fbfcfe" stroke="${color}" stroke-width="3"/>

      <!-- 코너 장식 -->
      <path d="M${W - 48 - 30} 0 h30 v30 z" fill="${color}"/>
      <rect x="14" y="14" width="10" height="10" fill="${color}" opacity="0.5" transform="rotate(45 19 19)"/>

      <!-- 캐릭터 아바타 칩 -->
      <circle cx="42" cy="-9" r="24" fill="#ffffff" stroke="${color}" stroke-width="3"/>
      <text x="42" y="-2" font-family="'Noto Sans KR', sans-serif" font-size="19" font-weight="800" fill="${color}" text-anchor="middle">${initial}</text>

      <!-- 이름표 -->
      <rect x="74" y="-30" width="${24 + name.length * 20 + 24}" height="44" rx="11" fill="${color}"/>
      <text x="98" y="-2" font-family="'Noto Sans KR', sans-serif" font-size="21" font-weight="700" fill="#ffffff">${escapeXml(name)}</text>

      <!-- 대사 -->
      <text x="0" y="66" font-family="'Noto Sans KR', sans-serif" font-size="26" font-weight="500" fill="#384049">${dialogueTextSvg}</text>

      <!-- 하단 우측 장식 버튼 + 다음 진행 표시 (한 줄로 정렬, 작동 안 함) -->
      <g transform="translate(${W - 48 - 210}, 210)">
        <rect x="0" y="0" width="70" height="30" rx="15" fill="${color}" opacity="0.14"/>
        <text x="35" y="20" font-family="'Noto Sans KR', sans-serif" font-size="12" font-weight="700" fill="${color}" text-anchor="middle">AUTO</text>
        <rect x="80" y="0" width="70" height="30" rx="15" fill="${color}" opacity="0.14"/>
        <text x="115" y="20" font-family="'Noto Sans KR', sans-serif" font-size="12" font-weight="700" fill="${color}" text-anchor="middle">SKIP</text>
        <g transform="translate(176,15)">
          <circle cx="0" cy="-7" r="3.4" fill="${color}"/>
          <path d="M-5.5 1 l5.5 6.5 l5.5 -6.5" stroke="${color}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
        </g>
      </g>
    </g>
  </g>
</svg>`.trim();
}

function clamp(n, min, max) {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 아주 단순한 글자수 기준 줄바꿈 (공백 우선, 없으면 강제 절단)
function wrapText(text, maxCharsPerLine) {
  if (!text) return [''];
  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (candidate.length > maxCharsPerLine) {
      if (current) lines.push(current);
      if (word.length > maxCharsPerLine) {
        let rest = word;
        while (rest.length > maxCharsPerLine) {
          lines.push(rest.slice(0, maxCharsPerLine));
          rest = rest.slice(maxCharsPerLine);
        }
        current = rest;
      } else {
        current = word;
      }
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
