const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const eventMap = fs.readFileSync(`${__dirname}/map_event.html`, 'utf8');
const sharedMap = fs.readFileSync(`${__dirname}/map_v2.html`, 'utf8');

test('이벤트 전용 지도는 클러스터링을 쓰지 않는다', () => {
  assert.ok(!/cluster/i.test(eventMap));
  assert.ok(!eventMap.includes('libraries=clusterer'));
  // 마커를 클러스터러에 넘기지 않고 지도에 직접 올린다
  assert.ok(eventMap.includes('window.markers.forEach(m => m.setMap(window.map));'));
  assert.ok(eventMap.includes('window.markers.forEach(m => m.setMap(null));'));
});

test('일반 지도의 클러스터링은 그대로 남아 있다', () => {
  assert.ok(sharedMap.includes('new kakao.maps.MarkerClusterer('));
  assert.ok(sharedMap.includes('libraries=clusterer'));
});

test('이벤트 전용 지도도 앱이 보내는 메시지와 핀 설정을 모두 처리한다', () => {
  for (const type of ['UPDATE_RESTAURANTS', 'UPDATE_EVENT_CONFIG', 'SET_MY_LOCATION', 'SET_SEARCH_LOCATION', 'PAN_TO']) {
    assert.ok(eventMap.includes(`message.type === '${type}'`), type);
  }
  assert.ok(eventMap.includes("postMessage(JSON.stringify({ type: 'SHOW_DIRECTIONS'"));
  assert.ok(eventMap.includes('event-pins.js'));
});
