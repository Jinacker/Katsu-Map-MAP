const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const pins = require('./event-pins');

const html = fs.readFileSync(`${__dirname}/map_event.html`, 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const places = JSON.parse(html.match(/const WALKING_PLACES = ([\s\S]*?);\n/)[1]);

// 실제 HTML의 초기화·SDK 클릭·앱 메시지를 실행한다. Kakao SDK와 DOM만 대체한다.
function boot({ native = true, queued = [] } = {}) {
  const errors = [];
  const posts = [];
  const timers = [];
  let document;
  class Element {
    constructor(id = '') { this.id = id; this.children = []; this.listeners = {}; this.attrs = {}; this.hidden = id === 'walking-modal'; this.style = {}; this.scrollLeft = 0; this.clientWidth = 280; this.textContent = ''; }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    fire(name, event = {}) { for (const fn of this.listeners[name] ?? []) fn({ target: this, ...event }); }
    appendChild(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    focus() { document.activeElement = this; }
    scrollBy({ left }) { this.scrollLeft += left; this.fire('scroll'); }
    querySelector() { return elements['walking-dialog']; }
    querySelectorAll() { return ['walking-close', 'walking-photo-prev', 'walking-photo-next'].map((id) => elements[id]); }
    get offsetParent() { return this.id.startsWith('walking-photo-') && elements['walking-gallery-controls'].hidden ? null : elements['walking-modal']; }
  }
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element(m[1])]));
  elements['walking-dialog'] = new Element();
  document = new Element();
  document.getElementById = (id) => elements[id];
  document.createElement = () => new Element();
  document.head = new Element();
  document.body = new Element();
  document.body.classList = { add() {} };
  document.activeElement = document.body;

  class Map {
    constructor(element, options) { this.level = options.level; }
    setMaxLevel() {}
    relayout() {}
    getLevel() { return this.level; }
    setLevel(level) { fire(this, 'zoom_start'); this.level = level; fire(this, 'zoom_changed'); }
    setCenter(position) { this.position = position; }
    panBy() {}
  }
  class Overlay {
    constructor(options) { Object.assign(this, options); }
    setMap(map) { this.map = map; }
    setImage(image) { this.image = image; }
  }
  const fire = (target, name) => { for (const fn of target.listeners?.[name] ?? []) fn(); };
  const window = new Element();
  Object.assign(window, { KAKAO_MAP_JS_KEY: 'test-key', KatsuEventPins: pins, location: { search: '?lat=37.59&lng=127.02&level=4' }, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), removeEventListener() {} });
  if (native) window.ReactNativeWebView = { postMessage: (data) => posts.push(JSON.parse(data)) };
  const kakao = { maps: {
    load: (fn) => fn(), Map, Marker: Overlay, CustomOverlay: Overlay,
    LatLng: class { constructor(lat, lng) { Object.assign(this, { lat, lng }); } },
    Size: class { constructor(width, height) { Object.assign(this, { width, height }); } },
    Point: class { constructor(x, y) { Object.assign(this, { x, y }); } },
    MarkerImage: class { constructor(url, size, options) { Object.assign(this, { url, size, options }); } },
    event: { addListener: (target, name, fn) => { ((target.listeners ??= {})[name] ??= []).push(fn); } },
  } };
  vm.runInNewContext(script, { window, document, kakao, URLSearchParams, console: { error: (...args) => errors.push(args) }, setTimeout: (fn) => timers.push(fn) });
  for (const message of queued) window.fire('message', { data: JSON.stringify(message) });
  document.head.children[0].onload();
  for (const fn of timers) fn();
  assert.deepEqual(errors, [], '지도 초기화 오류가 없어야 한다');
  return { window, elements, document, posts, fire, send: (message) => window.messageListener({ data: JSON.stringify(message) }) };
}

test('엑셀의 산책 장소 18곳과 번호별 사진 19장을 빠짐없이 매칭한다', () => {
  assert.deepEqual(places.map((place) => place.id), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(places.reduce((sum, place) => sum + place.images.length, 0), 19);
  assert.deepEqual(places.filter((place) => !place.images.length).map((place) => place.name), ['보문사-동망봉', '고려대학교 문과캠퍼스']);
  assert.equal(places[0].name, '길상사');
  assert.equal(places[0].lat, 37.59910978);
  assert.equal(places[0].lng, 126.99465204);
  assert.deepEqual(places[0].cafes, ['무카바']);
  assert.equal(places[17].name, '정릉천 제기2교');
  for (const place of places) {
    for (const key of ['restaurant', 'name', 'description', 'address']) assert.ok(place[key].trim(), `${place.id}: ${key}`);
    assert.ok(place.lat > 37.5 && place.lat < 37.7 && place.lng > 126.9 && place.lng < 127.1);
    assert.ok(place.cafes.length);
    for (const url of place.images) {
      assert.match(url, /^https:\/\/storage\.googleapis\.com\/katsu-map-images\/launch-banners\/events\/walks-[\w-]+\//);
      assert.match(url, new RegExp(`/${String(place.id).padStart(2, '0')}-[12]\\.jpg$`));
    }
  }
});

test('식당 목록·이벤트 설정 재전송과 확대·축소에도 산책핀이 보존되고 중복되지 않는다', () => {
  const { window, send } = boot({ queued: [{ type: 'UPDATE_RESTAURANTS', payload: [{ id: 1, lat: 37.59, lng: 127.01, name: '가게' }] }] });
  const markers = [...window.walkingMarkers];
  assert.equal(window.markers.length, 1, '초기화 전에 온 구버전 메시지도 처리');
  assert.equal(markers.length, 18);
  const svg = Buffer.from(markers[0].image.url.split(',')[1], 'base64').toString();
  assert.ok(svg.includes('fill="#B2DEE8"'));
  send({ type: 'UPDATE_RESTAURANTS', payload: [] });
  send({ type: 'UPDATE_EVENT_CONFIG', payload: null });
  send({ type: 'UPDATE_EVENT_CONFIG', payload: { enabled: true, restaurantIds: [1], pinMode: 'same' } });
  assert.equal(window.walkingMarkers.length, 18);
  assert.ok(markers.every((marker, i) => window.walkingMarkers[i] === marker && marker.map === window.map));
  window.map.setLevel(7);
  assert.ok(window.walkingOverlays.every((overlay) => overlay.map === null));
  assert.ok(markers.every((marker) => marker.map === window.map));
  window.map.setLevel(6);
  assert.ok(window.walkingOverlays.every((overlay) => overlay.map === window.map));
});

test('산책핀 클릭은 앱 식당 모달을 호출하지 않고 해당 장소·사진·카페를 보여준다', () => {
  const { window, elements, document, posts, fire } = boot();
  fire(window.walkingMarkers[0], 'click');
  assert.equal(elements['walking-modal'].hidden, false);
  assert.equal(elements['walking-restaurant'].textContent, '금왕돈까스 본점');
  assert.equal(elements['walking-name'].textContent, '길상사');
  assert.equal(elements['walking-address'].textContent, places[0].address);
  assert.equal(elements['walking-description'].textContent, places[0].description);
  assert.equal(elements['walking-cafes'].textContent, '무카바');
  assert.equal(elements['walking-photos'].children.length, 2);
  assert.equal(elements['walking-photo-count'].textContent, '1 / 2');
  elements['walking-photo-next'].fire('click');
  assert.equal(elements['walking-photo-count'].textContent, '2 / 2');
  assert.equal(elements['walking-photo-next'].disabled, true);
  elements['walking-photo-prev'].fire('click');
  assert.equal(elements['walking-photo-count'].textContent, '1 / 2');
  assert.equal(elements['walking-photo-prev'].disabled, true);
  assert.equal(document.activeElement, elements['walking-close']);
  assert.deepEqual(posts, []);
});

test('사진 없는 장소로 전환하면 이전 사진을 지우고 설명을 유지하며 닫기·배경·Escape가 동작한다', () => {
  const { window, elements, document, fire } = boot({ native: false });
  const clickPlace = (i) => fire(window.walkingMarkers[i], 'click');
  clickPlace(0);
  clickPlace(10);
  assert.equal(elements['walking-name'].textContent, '보문사-동망봉');
  assert.equal(elements['walking-gallery'].hidden, true);
  assert.equal(elements['walking-photos'].children.length, 0);
  assert.equal(elements['walking-cafes'].textContent, '크랙커피');
  elements['walking-close'].fire('click');
  assert.equal(elements['walking-modal'].hidden, true);
  assert.equal(document.activeElement, document.body);
  clickPlace(16);
  elements['walking-modal'].fire('click');
  assert.equal(elements['walking-modal'].hidden, true);
  clickPlace(0);
  document.fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(elements['walking-modal'].hidden, true);
  assert.equal(elements.map.attrs['aria-hidden'], undefined);
});

test('사진 로딩 실패가 장소 설명과 모달 닫기를 막지 않는다', () => {
  const { window, elements, fire } = boot();
  fire(window.walkingMarkers[0], 'click');
  const figure = elements['walking-photos'].children[0];
  figure.children[0].fire('error');
  assert.equal(figure.children[0].textContent, '사진을 불러오지 못했어요.');
  assert.equal(elements['walking-address'].textContent, places[0].address);
  elements['walking-close'].fire('click');
  assert.equal(elements['walking-modal'].hidden, true);
});

test('기존 식당핀은 산책 모달을 닫고 기존 SHOW_DIRECTIONS payload를 그대로 보낸다', () => {
  const { window, elements, posts, send, fire } = boot();
  const restaurant = { id: 99, name: '기존 식당', lat: 37.59, lng: 127.02, recommendLevel: 'normal' };
  send({ type: 'UPDATE_RESTAURANTS', payload: [restaurant] });
  fire(window.walkingMarkers[0], 'click');
  fire(window.markers[0], 'click');
  assert.equal(elements['walking-modal'].hidden, true);
  assert.deepEqual(posts, [{ type: 'SHOW_DIRECTIONS', payload: restaurant }]);
});
