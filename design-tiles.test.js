const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(`${__dirname}/map_event.html`, 'utf8');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(`${__dirname}/design-map-tiles/raster/manifest.js`, 'utf8'), context);
const config = context.window.KatsuEventDesignTiles;

// Actual Kakao SDK 4.5.29, LatLng(37.59, 127.02):
// WCONG = (504415.96024706203, 1136233.0528941646)
// Native tile plane = (1854131.0727905985, 4115945.7692613266).
// Using WCONG directly incorrectly classifies this point as outside the event.
const sdkTiles = [[3, 452, 1004], [4, 226, 502], [5, 113, 251], [6, 56, 125], [7, 28, 62]];

test('실제 SDK의 성북천 타일 좌표가 모든 지원 레벨에서 디자인 범위에 들어간다', () => {
  assert.equal(config.tileSize, 512);
  assert.equal(config.pixelRatio, 2);
  assert.equal(config.minLevel, 3);
  assert.equal(config.maxLevel, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(config.boundsWcong)), {
    west: 488819.33, east: 518158.34, south: 1120994.6, north: 1149407.69,
  });
  // 중심 이동 범위와 초기 표시 범위는 배경 범위 안에 있고, 실제 SDK의 성북천 중심을 포함한다.
  for (const inner of [config.navigationWcong, config.fitWcong]) {
    assert.ok(inner.west > config.boundsWcong.west && inner.east < config.boundsWcong.east);
    assert.ok(inner.south > config.boundsWcong.south && inner.north < config.boundsWcong.north);
    assert.ok(inner.west < 504415.96 && inner.east > 504415.96 && inner.south < 1136233.05 && inner.north > 1136233.05);
  }
  for (const [level, x, y] of sdkTiles) {
    const range = config.levels[level];
    assert.ok(range && x >= range.xMin && x <= range.xMax && y >= range.yMin && y <= range.yMax, `level ${level}`);
    const file = fs.readFileSync(`${__dirname}/design-map-tiles/raster/${level}/${x}-${y}.webp`);
    assert.equal(file.toString('ascii', 0, 4), 'RIFF');
    assert.equal(file.toString('ascii', 8, 12), 'WEBP');
    assert.ok(file.length > 1000, '성북천 중심은 단색 바탕 타일이어서는 안 된다');
  }
});

test('실제 HTML의 타일 URL 함수가 성북천은 이미지로, 범위 밖은 공용 바탕 타일로 연결한다', () => {
  let registered;
  class Tileset {
    constructor(width, height, url, copyrights, dark, min, max) {
      Object.assign(this, { width, height, url, min, max });
    }
    static add(id, value) { registered = value; }
  }
  const begin = html.indexOf('const designTiles =');
  const end = html.indexOf('const map = new kakao.maps.Map', begin);
  vm.runInNewContext(html.slice(begin, end), {
    window: { KatsuEventDesignTiles: config },
    kakao: { maps: { Tileset, MapTypeId: { SEONGBUKCHEON_DESIGN: 99 } } },
  });
  assert.ok(registered);
  assert.equal(registered.min, 3);
  assert.equal(registered.max, 7);
  for (const [level, x, y] of sdkTiles) {
    assert.equal(registered.url(x, y, level), `/design-map-tiles/raster/${level}/${x}-${y}.webp?v=${config.version}`);
  }
  assert.equal(registered.url(0, 0, 4), `/design-map-tiles/raster/blank.webp?v=${config.version}`);
  assert.ok(html.includes(`manifest.js?v=${config.version}`), 'HTML과 타일 버전이 함께 갱신되어야 한다');
});

test('배포 범위의 281개 디자인 타일이 모두 존재하고 제외한 1·2레벨은 남지 않는다', () => {
  let count = 0;
  for (const [level, range] of Object.entries(config.levels)) {
    assert.ok(Number(level) >= 3 && Number(level) <= 7);
    let levelCount = 0;
    for (let x = range.xMin; x <= range.xMax; x++) {
      for (let y = range.yMin; y <= range.yMax; y++) {
        assert.ok(fs.existsSync(`${__dirname}/design-map-tiles/raster/${level}/${x}-${y}.webp`));
        levelCount++;
      }
    }
    assert.equal(fs.readdirSync(`${__dirname}/design-map-tiles/raster/${level}`).length, levelCount);
    count += levelCount;
  }
  assert.equal(count, 281);
  for (const level of [1, 2]) assert.ok(!fs.existsSync(`${__dirname}/design-map-tiles/raster/${level}`));
  assert.ok(fs.existsSync(`${__dirname}/design-map-tiles/raster/blank.webp`));
});
