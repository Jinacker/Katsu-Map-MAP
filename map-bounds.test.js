const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(`${__dirname}/map_event.html`, 'utf8');
const begin = html.indexOf('// --- Event viewport bounds ---');
const end = html.indexOf('// --- End event viewport bounds ---');
assert.ok(begin >= 0 && end > begin);
const source = html.slice(begin, end) + '\nrestrictEventMapView();';

// 실제 HTML의 경계 제어를 실행한다. SDK의 공개 투영·이벤트 API만 대체한다.
function boot({ width = 400, height = 600, units = 10, bounds = { west: 0, east: 10000, south: 0, north: 8000 } } = {}) {
  const element = { clientWidth: width, clientHeight: height };
  const listeners = {};
  const windowListeners = {};
  const frames = new Map();
  let nextFrame = 0;
  let resize;
  let center = { x: 5000, y: 4000 };
  let scale = units;
  let corrections = 0;
  let layouts = 0;
  class Coords {
    constructor(x, y) { this.x = x; this.y = y; }
    getX() { return this.x; }
    getY() { return this.y; }
    toLatLng() { return { toCoords: () => this }; }
  }
  const fire = (event) => { for (const listener of listeners[event] ?? []) listener(); };
  const map = {
    getCenter: () => new Coords(center.x, center.y).toLatLng(),
    getProjection: () => ({
      coordsFromContainerPoint: ({ x, y }) => new Coords(
        center.x + (x - element.clientWidth / 2) * scale,
        center.y - (y - element.clientHeight / 2) * scale,
      ).toLatLng(),
    }),
    setCenter: (point) => {
      const coords = point.toCoords();
      center = { x: coords.getX(), y: coords.getY() };
      assert.ok(++corrections < 20, '경계 보정이 자기 자신을 반복 호출하면 안 된다');
      fire('bounds_changed');
      fire('idle');
    },
    relayout: () => { layouts++; fire('bounds_changed'); },
  };
  const window = {
    requestAnimationFrame: (fn) => { const id = ++nextFrame; frames.set(id, fn); return id; },
    addEventListener: (event, fn) => { windowListeners[event] = fn; },
    ResizeObserver: class {
      constructor(fn) { resize = fn; }
      observe(target) { assert.equal(target, element); }
    },
  };
  vm.runInNewContext(source, {
    map, window, designTiles: bounds ? { boundsWcong: bounds } : undefined,
    document: { getElementById: () => element },
    kakao: { maps: {
      Coords, Point: class { constructor(x, y) { this.x = x; this.y = y; } },
      event: { addListener: (target, event, fn) => { assert.equal(target, map); (listeners[event] ??= []).push(fn); } },
    } },
  });
  return {
    element, fire, frames, windowListeners,
    center: () => center, corrections: () => corrections, layouts: () => layouts,
    move: (x, y, event = 'drag') => { center = { x, y }; fire(event); },
    zoom: (value) => { scale = value; },
    resize: () => resize?.(),
    flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); },
  };
}

test('지도 안의 이동은 유지하고 사방 경계에서 화면 바깥 여백을 300m 이내로 제한한다', () => {
  const view = boot();
  view.move(6000, 4500);
  assert.deepEqual(view.center(), { x: 6000, y: 4500 });
  assert.equal(view.corrections(), 0);
  view.move(-100000, -100000);
  assert.deepEqual(view.center(), { x: 1250, y: 2250 });
  view.move(100000, 100000);
  assert.deepEqual(view.center(), { x: 8750, y: 5750 });
  assert.equal(view.corrections(), 2);
  assert.equal(view.frames.size, 0, '보정으로 발생한 이벤트가 추가 보정을 예약하지 않는다');
});

test('가까이 확대하면 여백을 화면의 25%까지 줄여 지도 전체가 바깥으로 사라지지 않는다', () => {
  const view = boot({ width: 100, height: 200, units: 1 });
  view.move(-10000, -10000);
  assert.deepEqual(view.center(), { x: 25, y: 50 });
  view.move(20000, 20000);
  assert.deepEqual(view.center(), { x: 9975, y: 7950 });
});

test('화면이 지도보다 크면 해당 방향을 중앙에 고정한다', () => {
  const view = boot({ width: 2000, height: 1600 });
  view.move(-10000, 30000);
  assert.deepEqual(view.center(), { x: 5000, y: 4000 });
  const portrait = boot({ units: 20 });
  portrait.move(-10000, 30000);
  assert.deepEqual(portrait.center(), { x: 3250, y: 4000 }, '세로만 고정하고 가로는 허용한다');
});

test('줌 애니메이션 중에는 카메라를 건드리지 않고 완료 후 새 배율로 제한한다', () => {
  const view = boot();
  view.fire('zoom_start');
  view.zoom(20);
  view.move(-10000, 30000, 'bounds_changed');
  view.fire('idle');
  view.flush();
  assert.equal(view.corrections(), 0);
  view.fire('zoom_changed');
  view.flush();
  assert.deepEqual(view.center(), { x: 3250, y: 4000 });
});

test('앱의 바깥 좌표 이동 요청은 한 프레임에 한 번 보정하고 경계에서 반복하지 않는다', () => {
  const view = boot();
  view.move(-100000, 100000, 'bounds_changed');
  view.fire('bounds_changed');
  view.fire('bounds_changed');
  assert.equal(view.frames.size, 1);
  view.flush();
  assert.deepEqual(view.center(), { x: 1250, y: 5750 });
  view.fire('idle');
  assert.equal(view.corrections(), 1);
});

test('화면 회전·WebView 크기 변경 후 표시 영역을 다시 계산하고 숨김 상태를 건너뛴다', () => {
  const view = boot();
  view.element.clientWidth = 0;
  view.move(-100000, 100000);
  assert.equal(view.corrections(), 0);
  view.element.clientWidth = 2000;
  view.element.clientHeight = 1600;
  view.resize();
  view.flush();
  assert.deepEqual(view.center(), { x: 5000, y: 4000 });
  assert.equal(view.layouts(), 1);
  view.element.clientWidth = 400;
  view.element.clientHeight = 600;
  view.move(-100000, 100000, 'no-event');
  view.windowListeners.resize();
  view.flush();
  assert.deepEqual(view.center(), { x: 1250, y: 5750 });
});

test('디자인 설정이 없는 기존 초기화 경로는 경계 제어 없이 유지한다', () => {
  const view = boot({ bounds: null });
  view.move(-100000, 100000);
  assert.deepEqual(view.center(), { x: -100000, y: 100000 });
  assert.equal(view.corrections(), 0);
});
