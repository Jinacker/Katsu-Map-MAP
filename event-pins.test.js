const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const pins = require('./event-pins');
const image = 'https://storage.googleapis.com/katsu-map-images/launch-banners/events/pin.svg';
test('구버전·비활성·비참여는 기본 핀이고 공통 핀은 모든 별점에 적용한다', () => {
  const restaurant = { id: 3, recommendLevel: 'normal' };
  assert.equal(pins.resolve(null, restaurant), null);
  assert.equal(pins.normalize({ enabled: false, restaurantIds: [3], pinMode: 'same' }), null);
  const config = pins.normalize({ enabled: true, restaurantIds: [3], pinMode: 'same', pinImageUrl: image });
  assert.equal(pins.resolve(config, restaurant), image);
  assert.equal(pins.resolve(config, { ...restaurant, id: 4 }), null);
  assert.equal(pins.resolve(config, { ...restaurant, recommendLevel: 'top5' }), image);
});
test('별점별 핀과 미설정 기본 핀 및 외부 주소 차단', () => {
  const config = pins.normalize({ enabled: true, restaurantIds: [3], pinMode: 'byRating', ratingPinImages: { '1': image, '2': image.replace('pin.svg', 'two.gif'), '3': 'https://evil.test/image.png' } });
  assert.equal(pins.resolve(config, { id: 3, recommendLevel: 'normal' }), image);
  assert.equal(pins.resolve(config, { id: 3, recommendLevel: 'good' }), image.replace('pin.svg', 'two.gif'));
  assert.equal(pins.resolve(config, { id: 3, recommendLevel: 'best' }), null);
  assert.equal(pins.resolve(config, { id: 3, recommendLevel: 'top5' }), null);
});
// 이벤트 디자인 핀은 이벤트 전용 지도에서만 쓴다. 일반 지도는 참여 가게도 평소 핀 그대로 표시한다.
test('일반 지도 v2·v3은 JS 문법이 유효하고 이벤트 핀을 쓰지 않는다', () => {
  for (const name of ['map.html', 'map_v2.html', 'map_v3.html']) {
    const html = fs.readFileSync(`${__dirname}/${name}`, 'utf8');
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    assert.doesNotMatch(html, /event-pins\.js|getEventPinImage|UPDATE_EVENT_CONFIG|isEventPin/);
  }
  for (const name of ['map_v2.html', 'map_v3.html']) {
    assert.match(fs.readFileSync(`${__dirname}/${name}`, 'utf8'), /image: getMarkerPinImage\(/);
  }
});
test('이벤트 전용 지도는 이벤트 핀 설정을 그대로 받는다', () => {
  const html = fs.readFileSync(`${__dirname}/map_event.html`, 'utf8');
  assert.match(html, /event-pins\.js/);
  assert.match(html, /UPDATE_EVENT_CONFIG/);
  assert.match(html, /getEventPinImage\(restaurant, isSelected\) \|\| getMarkerPinImage/);
});
