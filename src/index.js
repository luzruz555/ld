/**
 * VN 대화창 SVG 렌더러 — Cloudflare Worker
 *
 * 이미지는 GitHub 저장소에 아래 구조로 올려두고, 짧은 코드로 참조합니다.
 *   /bg/0.png ~ /bg/9.png            (배경 10종, 1216x832 권장, 꽉 채우는 그림)
 *   /char/U1_0.png ~ U1_4.png        (캐릭터 U1의 표정 0~4, 배경 투명 PNG 누끼)
 *   /char/U2_0.png ~ U5_4.png        (U2~U5 동일 규칙)
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
 * 이미지 경로 설정 방법
 *  1) 깃허브 저장소 루트에 bg 폴더, char 폴더를 만든다.
 *  2) bg 폴더 안에 0.png, 1.png ... 9.png 로 배경 이미지 10장을 넣는다.
 *  3) char 폴더 안에 U1_0.png, U1_1.png ... U5_4.png 로 캐릭터별 표정 이미지를 넣는다.
 *     (U1~U5 = 캐릭터 5명, _0~_4 = 표정 5종)
 *  4) 아래 GITHUB_BASE 를 본인 저장소의 raw 경로로 바꾼다.
 *     예) 저장소가 github.com/hurz/vn-assets, 기본 브랜치가 main이면:
 *     "https://raw.githubusercontent.com/hurz/vn-assets/main"
 *  5) 그러면 ?bg=3 은 자동으로 .../vn-assets/main/bg/3.png 를,
 *     ?char=U2_1 은 .../vn-assets/main/char/U2_1.png 를 가리키게 된다.
 *
 * 배포 방법: README.md 참고 (Workers Builds로 깃허브 push시 자동배포)
 */

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

    const bg = BG_CODE_RE.test(bgCode) ? `${GITHUB_BASE}/bg/${bgCode}.png` : '';
    const char = CHAR_CODE_RE.test(charCode) ? `${GITHUB_BASE}/char/${charCode}.png` : '';

    const W = 1216, H = 832;
    const level = Math.floor(affection / 20) + 1; // 1~5

    const dialogueLines = wrapText(line, 18);
    const dialogueTextSvg = dialogueLines
      .map((l, i) => `<tspan x="34" dy="${i === 0 ? 0 : 46}">${escapeXml(l)}</tspan>`)
      .join('');

    const affectionRatio = affection / 100;
    const barW = 150;
    const initial = escapeXml((name.trim()[0] || '?'));

    const svg = `
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
      ? `<image href="${escapeXml(char)}" x="${W - 620}" y="${H * 0.05}" width="600" height="${H * 0.9}" preserveAspectRatio="xMaxYMax meet"/>`
      : ''
    }

    <!-- 좌상단 호감도 바 -->
    <g transform="translate(24,24)">
      <rect x="0" y="0" width="272" height="58" rx="29" fill="#ffffff" fill-opacity="0.88"/>
      <!-- 레벨 배지 -->
      <circle cx="29" cy="29" r="17" fill="#ffffff" stroke="${color}" stroke-width="2.5"/>
      <text x="29" y="34" font-family="sans-serif" font-size="13" font-weight="800" fill="${color}" text-anchor="middle">Lv${level}</text>
      <!-- 하트 아이콘 -->
      <circle cx="68" cy="29" r="14" fill="${color}"/>
      <path d="M68 37 c-8.5 -5.3 -12.7 -10.6 -12.7 -15.9 c0 -4.2 3.2 -7.4 6.9 -7.4 c2.6 0 4.7 1.4 5.8 3.5 c1.1 -2.1 3.2 -3.5 5.8 -3.5 c3.7 0 6.9 3.2 6.9 7.4 c0 5.3 -4.2 10.6 -12.7 15.9z"
        fill="#ffffff" transform="translate(0,-4.5) scale(0.62) translate(0,12)" />
      <!-- 반짝임 장식 -->
      <path d="M89 12 l2.2 5.5 l5.5 2.2 l-5.5 2.2 l-2.2 5.5 l-2.2 -5.5 l-5.5 -2.2 l5.5 -2.2z" fill="${color}" opacity="0.85"/>
      <text x="93" y="21" font-family="sans-serif" font-size="11" font-weight="700" fill="#97a0ab">호감도 <tspan fill="#384049" font-size="13">${affection}</tspan></text>
      <rect x="93" y="30" width="${barW}" height="9" rx="4.5" fill="#eef2f7"/>
      <rect x="93" y="30" width="${(barW * affectionRatio).toFixed(1)}" height="9" rx="4.5" fill="${color}"/>
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
        <text x="17" y="21" font-family="sans-serif" font-size="11" font-weight="800" fill="#fff" text-anchor="middle">AUTO</text>
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
      <text x="42" y="-2" font-family="sans-serif" font-size="19" font-weight="800" fill="${color}" text-anchor="middle">${initial}</text>

      <!-- 이름표 -->
      <rect x="74" y="-30" width="${24 + name.length * 20 + 24}" height="44" rx="11" fill="${color}"/>
      <text x="98" y="-2" font-family="sans-serif" font-size="21" font-weight="700" fill="#ffffff">${escapeXml(name)}</text>

      <!-- 대사 -->
      <text x="0" y="66" font-family="sans-serif" font-size="26" font-weight="500" fill="#384049">${dialogueTextSvg}</text>

      <!-- 하단 우측 장식 버튼 + 다음 진행 표시 (한 줄로 정렬, 작동 안 함) -->
      <g transform="translate(${W - 48 - 210}, 210)">
        <rect x="0" y="0" width="70" height="30" rx="15" fill="${color}" opacity="0.14"/>
        <text x="35" y="20" font-family="sans-serif" font-size="12" font-weight="700" fill="${color}" text-anchor="middle">AUTO</text>
        <rect x="80" y="0" width="70" height="30" rx="15" fill="${color}" opacity="0.14"/>
        <text x="115" y="20" font-family="sans-serif" font-size="12" font-weight="700" fill="${color}" text-anchor="middle">SKIP</text>
        <g transform="translate(176,15)">
          <circle cx="0" cy="-7" r="3.4" fill="${color}"/>
          <path d="M-5.5 1 l5.5 6.5 l5.5 -6.5" stroke="${color}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
        </g>
      </g>
    </g>
  </g>
</svg>`.trim();

    return new Response(svg, {
      headers: {
        'content-type': 'image/svg+xml',
        'cache-control': 'public, max-age=3600',
      },
    });
  },
};

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
