const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const pins = require('./event-pins');

const html = fs.readFileSync(`${__dirname}/map_event.html`, 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const places = JSON.parse(html.match(/const WALKING_PLACES = ([\s\S]*?);\n/)[1]);

// 실제 HTML의 초기화·SDK 클릭·앱 메시지를 실행한다. Kakao SDK와 DOM만 대체한다.
function boot({ native = true, queued = [], reducedMotion = false } = {}) {
  const errors = [];
  const posts = [];
  const timers = [];
  const connections = [];
  const frames = new globalThis.Map();
  let nextFrame = 0;
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
  Object.assign(window, { KAKAO_MAP_JS_KEY: 'test-key', KatsuEventPins: pins, location: { search: '?lat=37.59&lng=127.02&level=4' }, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), removeEventListener() {},
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame: (fn) => { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  if (native) window.ReactNativeWebView = { postMessage: (data) => posts.push(JSON.parse(data)) };
  const kakao = { maps: {
    load: (fn) => fn(), Map, Marker: Overlay, CustomOverlay: Overlay,
    Polyline: class extends Overlay { constructor(options) { super(options); connections.push(this); } setPath(path) { this.path = path; } },
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
  const frame = (now) => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn(now)); };
  return { window, elements, document, posts, fire, connections, frames, frame, send: (message) => window.messageListener({ data: JSON.stringify(message) }) };
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
  assert.equal(document.activeElement, elements['walking-dialog']);
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

const restaurantFor = (index = 0) => ({ id: index + 1, name: places[index].restaurant, lat: 37.59 + index / 1000, lng: 127.01 + index / 1000, recommendLevel: 'best' });
const pinSvg = (marker) => Buffer.from(marker.image.url.split(',')[1], 'base64').toString();
const point = (position) => [position.lat, position.lng];

test('남색 화살표가 약 0.7초에 도착해야 상대 가게핀 테두리만 노랗게 바뀐다', () => {
  const { window, send, fire, connections, frame, frames } = boot();
  const restaurant = restaurantFor();
  send({ type: 'UPDATE_RESTAURANTS', payload: [restaurant] });
  send({ type: 'UPDATE_EVENT_CONFIG', payload: { enabled: true, restaurantIds: [restaurant.id], pinMode: 'same' } });
  fire(window.walkingMarkers[0], 'click');
  const line = connections[0];
  assert.equal(line.strokeColor.toLowerCase(), '#1e3c62');
  assert.equal(line.endArrow, true);
  assert.equal(line.strokeStyle, 'dash');
  assert.match(pinSvg(window.markers[0]), /fill="#1E3C62"/);
  assert.doesNotMatch(pinSvg(window.markers[0]), /stroke="#FFCC33"/);
  frame(0); frame(350);
  assert.notDeepEqual(point(line.path[1]), [restaurant.lat, restaurant.lng]);
  assert.doesNotMatch(pinSvg(window.markers[0]), /stroke="#FFCC33"/);
  frame(700);
  assert.deepEqual(point(line.path[0]), [places[0].lat, places[0].lng]);
  assert.deepEqual(point(line.path[1]), [restaurant.lat, restaurant.lng]);
  assert.equal(frames.size, 0);
  assert.match(pinSvg(window.markers[0]), /fill="#1E3C62" stroke="#FFCC33"/);
  assert.ok(window.overlays[0].content.includes('background:rgba(255,255,255,0.85)'));
});

test('닫기·배경·Escape로 모달을 닫아도 진행 중 연결선과 도착 후 강조를 유지한다', () => {
  for (const close of [({ elements }) => elements['walking-close'].fire('click'), ({ elements }) => elements['walking-modal'].fire('click'), ({ document }) => document.fire('keydown', { key: 'Escape', preventDefault() {} })]) {
    const state = boot();
    const { window, elements, send, fire, connections, frame } = state;
    send({ type: 'UPDATE_RESTAURANTS', payload: [restaurantFor()] });
    fire(window.walkingMarkers[0], 'click'); frame(0);
    const line = connections[0];
    close(state);
    assert.equal(elements['walking-modal'].hidden, true);
    assert.equal(line.map, window.map);
    frame(700);
    assert.match(pinSvg(window.markers[0]), /stroke="#FFCC33"/);
    assert.equal(line.map, window.map);
    fire(window.map, 'click'); fire(window.map, 'dragstart'); window.map.setLevel(6);
    assert.equal(line.map, window.map);
    assert.match(pinSvg(window.markers[0]), /stroke="#FFCC33"/);
  }
});

test('가게핀 클릭은 산책 방향으로 연결하고 도착 후 산책핀의 파란 바탕을 유지하며 테두리만 강조한다', () => {
  const { window, send, fire, connections, frame, posts, elements } = boot();
  const restaurant = restaurantFor();
  send({ type: 'UPDATE_RESTAURANTS', payload: [restaurant] });
  window.map.setLevel(7);
  fire(window.markers[0], 'click');
  assert.equal(window.map.getLevel(), 4);
  assert.equal(elements['walking-modal'].hidden, true);
  assert.deepEqual(posts, [{ type: 'SHOW_DIRECTIONS', payload: restaurant }]);
  const line = connections[0];
  frame(0); frame(350);
  assert.deepEqual(point(line.path[0]), [restaurant.lat, restaurant.lng]);
  assert.doesNotMatch(pinSvg(window.walkingMarkers[0]), /stroke="#FFCC33"/);
  frame(700);
  assert.deepEqual(point(line.path[1]), [places[0].lat, places[0].lng]);
  assert.match(pinSvg(window.walkingMarkers[0]), /fill="#B2DEE8" stroke="#FFCC33"/);
  assert.doesNotMatch(pinSvg(window.markers[0]), /stroke="#FFCC33"/);
  send({ type: 'PAN_TO', payload: { lat: restaurant.lat, lng: restaurant.lng, level: 4 } });
  assert.equal(line.map, window.map);
  assert.match(pinSvg(window.walkingMarkers[0]), /stroke="#FFCC33"/);
});

test('빠르게 코스와 방향을 바꾸면 이전 선·강조·예약 프레임을 지우고 새 상대만 강조한다', () => {
  const { window, send, fire, connections, frame } = boot();
  const restaurants = [restaurantFor(0), restaurantFor(1)];
  send({ type: 'UPDATE_RESTAURANTS', payload: restaurants });
  fire(window.walkingMarkers[0], 'click'); frame(0);
  const oldLine = connections[0];
  fire(window.markers[1], 'click');
  assert.equal(oldLine.map, null);
  const line = connections[1];
  frame(700);
  assert.doesNotMatch(pinSvg(window.walkingMarkers[1]), /stroke="#FFCC33"/);
  frame(1400);
  assert.equal(line.map, window.map);
  assert.match(pinSvg(window.walkingMarkers[1]), /stroke="#FFCC33"/);
  assert.doesNotMatch(pinSvg(window.markers[0]), /stroke="#FFCC33"/);
  fire(window.walkingMarkers[0], 'click');
  assert.doesNotMatch(pinSvg(window.walkingMarkers[1]), /stroke="#FFCC33"/);
  frame(1500); frame(2200);
  assert.match(pinSvg(window.markers[0]), /stroke="#FFCC33"/);
});

test('같은 핀 재선택·목록/설정 재전송·필터 변경에도 다른 핀을 누르기 전까지 선을 유지한다', () => {
  const { window, send, fire, connections, frame, elements } = boot();
  const restaurant = restaurantFor();
  send({ type: 'UPDATE_RESTAURANTS', payload: [restaurant] });
  fire(window.markers[0], 'click'); frame(0); frame(700);
  const line = connections[0];
  fire(window.markers[0], 'click');
  send({ type: 'UPDATE_RESTAURANTS', payload: [{ ...restaurant }] });
  send({ type: 'UPDATE_EVENT_CONFIG', payload: { enabled: true, restaurantIds: [restaurant.id], pinMode: 'same' } });
  assert.equal(connections.length, 1);
  assert.deepEqual(point(line.path[0]), [restaurant.lat, restaurant.lng]);
  assert.deepEqual(point(line.path[1]), [places[0].lat, places[0].lng]);
  assert.equal(elements['walking-modal'].hidden, true);
  assert.match(pinSvg(window.walkingMarkers[0]), /stroke="#FFCC33"/);
  send({ type: 'UPDATE_RESTAURANTS', payload: [] });
  assert.equal(line.map, window.map);
  assert.match(pinSvg(window.walkingMarkers[0]), /stroke="#FFCC33"/);
  send({ type: 'UPDATE_RESTAURANTS', payload: [restaurantFor(5)] });
  assert.equal(line.map, window.map);
  fire(window.markers[0], 'click'); frame(800); frame(1500);
  assert.equal(line.map, null);
  assert.match(pinSvg(window.walkingMarkers[5]), /stroke="#FFCC33"/);
  send({ type: 'UPDATE_RESTAURANTS', payload: [{ ...restaurant, name: '매칭 없는 가게' }] });
  fire(window.markers[0], 'click');
  assert.ok(connections.every((connection) => connection.map === null));
  assert.ok(window.walkingMarkers.every((marker) => !pinSvg(marker).includes('stroke="#FFCC33"')));
});

test('매칭 누락·중복·잘못된 좌표로 새 코스를 선택하면 이전 연결을 지우고 잘못 연결하지 않는다', () => {
  const restaurant = restaurantFor();
  for (const payload of [[], [restaurant, { ...restaurant, id: 99 }], [{ ...restaurant, lat: '' }], [{ ...restaurant, lng: Infinity }]]) {
    const { window, send, fire, connections, frame } = boot();
    send({ type: 'UPDATE_RESTAURANTS', payload: [restaurantFor(1)] });
    fire(window.walkingMarkers[1], 'click'); frame(0); frame(700);
    send({ type: 'UPDATE_RESTAURANTS', payload });
    fire(window.walkingMarkers[0], 'click');
    assert.ok(connections.every((connection) => connection.map === null));
    assert.ok(window.markers.every((marker) => !pinSvg(marker).includes('stroke="#FFCC33"')));
    assert.ok(window.walkingMarkers.every((marker) => !pinSvg(marker).includes('stroke="#FFCC33"')));
  }
});

test('선택한 가게가 목록 재전송으로 새 객체가 돼도 도착한 노란 테두리와 같은 선을 유지한다', () => {
  const { window, elements, send, fire, connections, frame } = boot();
  const restaurant = restaurantFor();
  send({ type: 'UPDATE_RESTAURANTS', payload: [restaurant] });
  fire(window.walkingMarkers[0], 'click'); frame(0); frame(700);
  elements['walking-close'].fire('click');
  send({ type: 'UPDATE_RESTAURANTS', payload: [{ ...restaurant }] });
  assert.match(pinSvg(window.markers[0]), /stroke="#FFCC33"/);
  assert.equal(connections.length, 1);
  assert.equal(connections[0].map, window.map);
  fire(window.walkingMarkers[0], 'click');
  assert.equal(elements['walking-modal'].hidden, false);
  assert.equal(connections.length, 1);
});

test('동작 줄이기에서는 양방향 모두 완성된 선을 표시한 직후 상대만 강조한다', () => {
  const { window, send, fire, connections, frames } = boot({ reducedMotion: true });
  const restaurant = restaurantFor();
  send({ type: 'UPDATE_RESTAURANTS', payload: [restaurant] });
  fire(window.walkingMarkers[0], 'click');
  assert.deepEqual(point(connections[0].path[1]), [restaurant.lat, restaurant.lng]);
  assert.match(pinSvg(window.markers[0]), /stroke="#FFCC33"/);
  fire(window.markers[0], 'click');
  assert.deepEqual(point(connections[1].path[1]), [places[0].lat, places[0].lng]);
  assert.match(pinSvg(window.walkingMarkers[0]), /stroke="#FFCC33"/);
  assert.equal(frames.size, 0);
});
