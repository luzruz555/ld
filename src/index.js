/**
 * VN 대화창 렌더러 — Cloudflare Worker (무료 플랜에서 동작, 최종 출력 PNG)
 *
 * 이미지는 GitHub 저장소에 아래 구조로 올려두고, 짧은 코드로 참조합니다.
 *   /bg/0.png ~ /bg/9.png            (배경 10종, 1216x832 권장, 꽉 채우는 그림)
 *   /bg/t.png                        (테스트용 배경, bg=t)
 *   /char/U1_0.png ~ U1_4.png        (캐릭터 U1의 표정 0~4, 배경 투명 PNG 누끼)
 *   /char/LUZ_0.png                  (테스트용 캐릭터, char=LUZ_0)
 *   /char/U2_0.png ~ U5_4.png        (U2~U5 동일 규칙)
 *
 * ※ 동작 방식
 *   워커 자체는 SVG를 조립하기만 해서 CPU를 거의 안 씁니다 (무료 플랜 10ms 한도 안전).
 *   대신 실제 PNG 변환은 wsrv.nl(외부 무료 이미지 프록시)에 맡깁니다.
 *   사용자는 아래 URL을 그대로 마크다운에 넣기만 하면 됩니다 — 인코딩 등 손댈 것 없음.
 *   워커가 내부적으로 자기 자신의 SVG 주소를 인코딩해서 wsrv.nl에 넘기고,
 *   변환된 진짜 PNG를 그대로 돌려줍니다.
 *   (혹시 SVG 그대로 필요하면 URL 끝에 &format=svg 를 붙이면 됩니다.)
 *
 * 사용법 (마크다운 예시, 인코딩 불필요):
 * ![](https://YOUR-WORKER.workers.dev/?bg=3&char=U1_2&name=서윤슬&line=대사내용&affection=65&color=pink)
 *
 * 쿼리 파라미터
 *  bg         : 0~9 또는 t (배경 코드, 없으면 기본 그라데이션)
 *  char       : U1_0 ~ U5_4 또는 LUZ_0 (캐릭터_표정 코드, 없으면 표시 안 함)
 *  name       : 이름표 텍스트 (기본 "이름")
 *  line       : 대사 텍스트 (기본 빈 문자열)
 *  affection  : 0~100 숫자 (기본 35)
 *  color      : red / sky / yellow / pink / gray  중 하나 (한글 "빨강/하늘/노랑/핑크/회색"도 가능, 기본 sky)
 *  format=svg : (선택) 실제 PNG 대신 가벼운 SVG를 그대로 받고 싶을 때
 *
 * 배포 방법: README.md 참고 (Workers Builds로 깃허브 push시 자동배포)
 */

// ⚠️ 여기를 본인 GitHub 저장소 raw 경로로 교체하세요
const GITHUB_BASE = 'https://raw.githubusercontent.com/luzruz555/ld/main';

const BG_CODE_RE = /^([0-9]|t)$/;
const CHAR_CODE_RE = /^(U[1-5]_[0-4]|LUZ_0)$/;

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

    const svg = buildSvg({ bg, char, name, line, affection, color });

    // ?format=svg 로 요청하면 (또는 wsrv.nl이 내부적으로 우리 자신을 다시 호출할 때)
    // 가벼운 SVG를 그대로 반환한다. CPU 사용량이 거의 없어 무료 플랜에 안전하다.
    const isInternalSvgRequest = params.get('format') === 'svg' || params.has('__svg');
    if (isInternalSvgRequest) {
      return new Response(svg, {
        headers: {
          'content-type': 'image/svg+xml',
          'cache-control': 'public, max-age=3600',
        },
      });
    }

    // 기본 동작: 사용자가 그대로 마크다운에 넣는 이 URL 자체가 진짜 PNG를 돌려준다.
    // 워커가 자기 자신의 SVG 주소를 내부적으로 인코딩해서 wsrv.nl에 넘기고,
    // wsrv.nl이 실제로 SVG→PNG 변환을 수행한 결과를 그대로 스트리밍해서 돌려준다.
    // (fetch 대기시간은 Workers의 CPU 과금 시간에 포함되지 않으므로 10ms 한도에 안전하다.)
    const selfSvgUrl = new URL(request.url);
    selfSvgUrl.searchParams.set('__svg', '1');
    const wsrvUrl = `https://wsrv.nl/?url=${encodeURIComponent(selfSvgUrl.toString())}&output=png`;

    try {
      const pngRes = await fetch(wsrvUrl);
      if (!pngRes.ok) {
        // wsrv.nl 쪽 문제 시, 최소한 SVG라도 보여주도록 폴백
        return new Response(svg, {
          headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=300' },
        });
      }
      return new Response(pngRes.body, {
        headers: {
          'content-type': pngRes.headers.get('content-type') || 'image/png',
          'cache-control': 'public, max-age=3600',
        },
      });
    } catch (err) {
      // 네트워크 오류 등 예외 상황에서도 SVG 폴백
      return new Response(svg, {
        headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=300' },
      });
    }
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
