/**
 * VN 대화창 SVG 렌더러 — Cloudflare Worker
 *
 * 이미지는 GitHub 저장소에 아래 구조로 올려두고, 짧은 코드로 참조합니다.
 *   /bg/0.png ~ /bg/9.png            (배경 10종)
 *   /char/U1_0.png ~ U1_4.png        (캐릭터 U1의 표정 0~4)
 *   /char/U2_0.png ~ U5_4.png        (U2~U5 동일 규칙)
 *
 * 사용법 (마크다운 예시):
 * ![](https://YOUR-WORKER.workers.dev/?bg=3&char=U1_2&name=서윤슬&line=대사내용&affection=65&color=%234fc3e8)
 *
 * 쿼리 파라미터
 *  bg         : 0~9 숫자 (배경 코드, 없으면 기본 그라데이션)
 *  char       : U1_0 ~ U5_4 형식 (캐릭터_표정 코드, 없으면 표시 안 함)
 *  name       : 이름표 텍스트 (기본 "이름")
 *  line       : 대사 텍스트 (기본 빈 문자열)
 *  affection  : 0~100 숫자 (기본 35)
 *  color      : accent 색상 hex, # 은 %23 으로 인코딩 (기본 #4fc3e8)
 *
 * 배포 전 꼭 할 일
 *  아래 GITHUB_BASE 를 본인 저장소 경로로 교체하세요.
 *  예) 저장소가 github.com/hurz/vn-assets 이고 기본 브랜치가 main이면:
 *  "https://raw.githubusercontent.com/hurz/vn-assets/main"
 *
 * 배포 방법
 *  1. Cloudflare 대시보드 → Workers & Pages → Create Worker
 *  2. 편집기에 이 파일 내용 전체 붙여넣기 (GITHUB_BASE 교체 후) → Deploy
 *  3. 발급된 workers.dev 주소 뒤에 쿼리 파라미터 붙여서 사용
 */

// ⚠️ 여기를 본인 GitHub 저장소 raw 경로로 교체하세요
const GITHUB_BASE = 'https://raw.githubusercontent.com/luzruz555/ld/main';

const BG_CODE_RE = /^[0-9]$/;
const CHAR_CODE_RE = /^U[1-5]_[0-4]$/;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const params = url.searchParams;

    const bgCode = params.get('bg') || '';
    const charCode = params.get('char') || '';
    const name = params.get('name') || '이름';
    const line = params.get('line') || '';
    const affection = clamp(parseInt(params.get('affection') || '35', 10), 0, 100);
    const color = params.get('color') || '#4fc3e8';

    const bg = BG_CODE_RE.test(bgCode) ? `${GITHUB_BASE}/bg/${bgCode}.png` : '';
    const char = CHAR_CODE_RE.test(charCode) ? `${GITHUB_BASE}/char/${charCode}.png` : '';

    const W = 1216, H = 832;

    const dialogueLines = wrapText(line, 30); // 한 줄당 약 30자
    const dialogueTextSvg = dialogueLines
      .map((l, i) => `<tspan x="30" dy="${i === 0 ? 0 : 34}">${escapeXml(l)}</tspan>`)
      .join('');

    const affectionRatio = affection / 100;
    const barW = 160;

    const svg = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="skyDefault" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#bfe4f7"/>
      <stop offset="55%" stop-color="#8fc9ea"/>
      <stop offset="100%" stop-color="#d7ecf7"/>
    </linearGradient>
    <clipPath id="stageClip">
      <rect x="0" y="0" width="${W}" height="${H}" rx="12"/>
    </clipPath>
  </defs>

  <g clip-path="url(#stageClip)">
    <!-- 배경 -->
    ${bg
      ? `<image href="${escapeXml(bg)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`
      : `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#skyDefault)"/>`
    }

    <!-- 캐릭터 -->
    ${char
      ? `<image href="${escapeXml(char)}" x="${W - 620}" y="${H * 0.06}" width="600" height="${H * 0.9}" preserveAspectRatio="xMaxYMax meet"/>`
      : ''
    }

    <!-- 좌상단 호감도 바 -->
    <g transform="translate(24,24)">
      <rect x="0" y="0" width="216" height="52" rx="26" fill="#ffffff" fill-opacity="0.85"/>
      <circle cx="26" cy="26" r="13" fill="${color}"/>
      <path d="M26 33 c-8 -5 -12 -10 -12 -15 c0 -4 3 -7 6.5 -7 c2.5 0 4.5 1.3 5.5 3.3 c1 -2 3 -3.3 5.5 -3.3 c3.5 0 6.5 3 6.5 7 c0 5 -4 10 -12 15z"
        fill="#ffffff" transform="translate(0,-3) scale(0.62)" />
      <text x="48" y="19" font-family="sans-serif" font-size="10" font-weight="700" fill="#97a0ab">호감도 <tspan fill="#384049">${affection}</tspan></text>
      <rect x="48" y="26" width="${barW}" height="7" rx="4" fill="#eef2f7"/>
      <rect x="48" y="26" width="${(barW * affectionRatio).toFixed(1)}" height="7" rx="4" fill="${color}"/>
    </g>

    <!-- 대화창 -->
    <g transform="translate(24, ${H - 24 - 190})">
      <rect x="0" y="0" width="${W - 48}" height="190" rx="14" fill="#fbfcfe" stroke="${color}" stroke-width="3"/>
      <rect x="20" y="-19" width="${20 + name.length * 15 + 20}" height="38" rx="9" fill="${color}"/>
      <text x="40" y="6" font-family="sans-serif" font-size="16" font-weight="700" fill="#ffffff">${escapeXml(name)}</text>
      <text x="0" y="55" font-family="sans-serif" font-size="16" font-weight="500" fill="#384049">${dialogueTextSvg}</text>
      <circle cx="${W - 48 - 30}" cy="170" r="4" fill="${color}"/>
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
      // 단어 자체가 maxChars보다 길면 강제 절단
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
