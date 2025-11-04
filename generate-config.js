#!/usr/bin/env node

/**
 * 환경변수에서 API 키를 읽어서 config.js 생성
 *
 * 로컬: .env 파일에서 읽음
 * Vercel: process.env에서 읽음 (Vercel 환경변수)
 *
 * 사용법:
 *   node generate-config.js
 */

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.js');

// 환경변수에서 직접 읽기 (Vercel 우선)
let KAKAO_MAP_JS_KEY = process.env.KAKAO_MAP_JS_TEST_KEY || process.env.KAKAO_MAP_JS_KEY;
let KAKAO_MAP_REST_KEY = process.env.KAKAO_MAP_REST_TEST_KEY || process.env.KAKAO_MAP_REST_KEY;

// 환경변수가 없으면 .env 파일 읽기 (로컬 개발용)
if (!KAKAO_MAP_JS_KEY || !KAKAO_MAP_REST_KEY) {
  const envPath = path.join(__dirname, '.env');

  if (fs.existsSync(envPath)) {
    console.log('📁 .env 파일에서 환경변수 읽는 중...');
    const envContent = fs.readFileSync(envPath, 'utf-8');

    // 환경변수 파싱
    const envVars = {};
    envContent.split('\n').forEach(line => {
      line = line.trim();

      // 주석이나 빈 줄 무시
      if (!line || line.startsWith('#')) return;

      // KEY="VALUE" 또는 KEY=VALUE 형식 파싱
      const match = line.match(/^([^=]+)=["']?([^"']*)["']?$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        envVars[key] = value;
      }
    });

    // TEST 키 우선 사용, 없으면 일반 키 사용
    KAKAO_MAP_JS_KEY = envVars.KAKAO_MAP_JS_TEST_KEY || envVars.KAKAO_MAP_JS_KEY;
    KAKAO_MAP_REST_KEY = envVars.KAKAO_MAP_REST_TEST_KEY || envVars.KAKAO_MAP_REST_KEY;
  }
}

if (!KAKAO_MAP_JS_KEY || !KAKAO_MAP_REST_KEY) {
  console.error('❌ .env 파일에 필요한 키가 없습니다!');
  console.error('필요한 키: KAKAO_MAP_JS_TEST_KEY, KAKAO_MAP_REST_TEST_KEY');
  process.exit(1);
}

// config.js 생성
const configContent = `// 자동 생성된 파일 - 수동으로 수정하지 마세요!
// .env 파일에서 생성됨: ${new Date().toISOString()}
// ⚠️ 이 파일은 .gitignore에 포함되어 git에 커밋되지 않습니다

window.KAKAO_MAP_JS_KEY = '${KAKAO_MAP_JS_KEY}';
window.KAKAO_MAP_REST_KEY = '${KAKAO_MAP_REST_KEY}';
`;

fs.writeFileSync(configPath, configContent, 'utf-8');

console.log('✅ config.js 파일이 생성되었습니다!');
console.log('📁 위치:', configPath);
console.log('🔑 KAKAO_MAP_JS_KEY:', KAKAO_MAP_JS_KEY.substring(0, 10) + '...');
console.log('🔑 KAKAO_MAP_REST_KEY:', KAKAO_MAP_REST_KEY.substring(0, 10) + '...');
