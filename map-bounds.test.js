const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(`${__dirname}/map_event.html`, 'utf8');
const begin = html.indexOf('// --- Event viewport bounds ---');
const end = html.indexOf('// --- End event viewport bounds ---');
assert.ok(begin >= 0 && end > begin);
const source = html.slice(begin, end) + '\nrestrictEventMapView();';

// 실제 HTML의 경계 제어를 실행한다. SDK의 공개 투영·이벤트·레벨 API만 대체한다.
// units는 시작 레벨에서 화면 1px이 차지하는 WCONG 길이이며, 레벨이 1 오르면 2배가 된다.
function boot({
  width = 400, height = 600, units = 10, level = 5,
  bounds = { west: 0, east: 10000, south: 0, north: 8000 },
  navigation = { west: 3000, east: 7000, south: 2000, north: 6000 },
} = {}) {
  const element = { clientWidth: width, clientHeight: height };
  const listeners = {};
  const windowListeners = {};
  const frames = new Map();
  let nextFrame = 0;
  let resize;
  let center = { x: 5000, y: 4000 };
  let currentLevel = level;
  let corrections = 0;
  let layouts = 0;
  const maxLevels = [];
  const scale = () => units * 2 ** (currentLevel - level);
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
        center.x + (x - element.clientWidth / 2) * scale(),
        center.y - (y - element.clientHeight / 2) * scale(),
      ).toLatLng(),
    }),
    getLevel: () => currentLevel,
    setMaxLevel: (value) => { maxLevels.push(value); },
    setLevel: (value) => { fire('zoom_start'); currentLevel = value; fire('zoom_changed'); },
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
  const context = {
    map, window,
    designTiles: bounds ? { boundsWcong: bounds, navigationWcong: navigation ?? undefined, minLevel: 3, maxLevel: 7 } : undefined,
    document: { getElementById: () => element },
    kakao: { maps: {
      Coords, Point: class { constructor(x, y) { this.x = x; this.y = y; } },
      event: { addListener: (target, event, fn) => { assert.equal(target, map); (listeners[event] ??= []).push(fn); } },
    } },
  };
  vm.runInNewContext(source, context);
  return {
    element, fire, frames, windowListeners, maxLevels,
    center: () => center, level: () => currentLevel, corrections: () => corrections, layouts: () => layouts,
    move: (x, y, event = 'drag') => { center = { x, y }; fire(event); },
    zoomTo: (value) => { currentLevel = value; },
    focus: (x, y) => vm.runInContext(`focusedEventPinPosition = { toCoords: () => new kakao.maps.Coords(${x}, ${y}) };`, context),
    resize: () => resize?.(),
    flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); },
  };
}

test('지도 안의 이동은 유지하고 화면이 배경 밖으로 나가지 않게 중심을 이동 범위 안으로 제한한다', () => {
  const view = boot();
  view.move(6000, 4500);
  assert.deepEqual(view.center(), { x: 6000, y: 4500 });
  assert.equal(view.corrections(), 0);
  view.move(-100000, -100000);
  assert.deepEqual(view.center(), { x: 3000, y: 3010 });
  view.move(100000, 100000);
  assert.deepEqual(view.center(), { x: 7000, y: 4990 });
  assert.equal(view.corrections(), 2);
  assert.equal(view.frames.size, 0, '보정으로 발생한 이벤트가 추가 보정을 예약하지 않는다');
  assert.deepEqual(view.maxLevels, [5]);
});

test('가까이 확대하면 중심 이동 범위가 그대로 경계가 된다', () => {
  const view = boot({ width: 100, height: 200, units: 1, level: 3 });
  view.move(-10000, -10000);
  assert.deepEqual(view.center(), { x: 3000, y: 2000 });
  view.move(20000, 20000);
  assert.deepEqual(view.center(), { x: 7000, y: 6000 });
  assert.deepEqual(view.maxLevels, [7]);
});

test('화면 전체가 배경 안에 들어가는 레벨까지만 축소를 허용하고 넘으면 한 단계 당긴다', () => {
  const view = boot({ level: 6, units: 20 });
  view.fire('idle');
  assert.deepEqual(view.maxLevels, [5]);
  assert.equal(view.level(), 5);
  assert.equal(view.frames.size, 1, '레벨 변경 후 새 배율로 다시 제한한다');
  view.flush();
  assert.deepEqual(view.center(), { x: 5000, y: 4000 });
  assert.equal(view.corrections(), 0);
});

test('가장 확대한 레벨에서도 화면이 배경보다 크면 해당 방향을 중앙에 고정한다', () => {
  const view = boot({ level: 3, bounds: { west: 0, east: 1000, south: 0, north: 800 }, navigation: { west: 300, east: 700, south: 200, north: 600 } });
  view.move(-10000, 30000);
  assert.deepEqual(view.center(), { x: 500, y: 400 });
  assert.deepEqual(view.maxLevels, [3]);
  const portrait = boot({ height: 1000, level: 3 });
  portrait.move(-10000, 30000);
  assert.deepEqual(portrait.center(), { x: 3000, y: 4000 }, '세로만 고정하고 가로는 이동 범위 안에서 허용한다');
});

test('줌 애니메이션 중에는 카메라를 건드리지 않고 완료 후 새 배율로 제한한다', () => {
  const view = boot();
  view.fire('zoom_start');
  view.zoomTo(4);
  view.move(-10000, 30000, 'bounds_changed');
  view.fire('idle');
  view.flush();
  assert.equal(view.corrections(), 0);
  view.fire('zoom_changed');
  view.flush();
  assert.deepEqual(view.center(), { x: 3000, y: 6000 });
});

test('앱의 바깥 좌표 이동 요청은 한 프레임에 한 번 보정하고 경계에서 반복하지 않는다', () => {
  const view = boot();
  view.move(-100000, 100000, 'bounds_changed');
  view.fire('bounds_changed');
  view.fire('bounds_changed');
  assert.equal(view.frames.size, 1);
  view.flush();
  assert.deepEqual(view.center(), { x: 3000, y: 4990 });
  view.fire('idle');
  assert.equal(view.corrections(), 1);
});

test('화면 회전·WebView 크기 변경 후 표시 영역과 축소 한계를 다시 계산하고 숨김 상태를 건너뛴다', () => {
  const view = boot();
  view.element.clientWidth = 0;
  view.move(-100000, 100000);
  assert.equal(view.corrections(), 0);
  view.element.clientWidth = 300;
  view.element.clientHeight = 300;
  view.resize();
  view.flush();
  assert.deepEqual(view.center(), { x: 3000, y: 6000 });
  assert.equal(view.layouts(), 1);
  view.element.clientWidth = 400;
  view.element.clientHeight = 600;
  view.move(-100000, 100000, 'no-event');
  view.windowListeners.resize();
  view.flush();
  assert.deepEqual(view.center(), { x: 3000, y: 4990 });
  assert.deepEqual(view.maxLevels, [6, 5]);
});

test('선택한 핀은 이동 범위 밖이어도 중앙에 두되 화면이 배경 밖으로 나가지는 않는다', () => {
  const view = boot();
  view.focus(7500, 7600);
  view.move(100000, 100000);
  assert.deepEqual(view.center(), { x: 7500, y: 4990 });
  view.focus(9500, 4000);
  view.move(100000, 4000);
  assert.deepEqual(view.center(), { x: 7990, y: 4000 });
});

test('이동 범위가 없는 이전 manifest는 배경 범위 안에서만 제한한다', () => {
  const view = boot({ navigation: null });
  view.move(-100000, -100000);
  assert.deepEqual(view.center(), { x: 2010, y: 3010 });
});

test('디자인 설정이 없는 기존 초기화 경로는 경계 제어 없이 유지한다', () => {
  const view = boot({ bounds: null });
  view.move(-100000, 100000);
  assert.deepEqual(view.center(), { x: -100000, y: 100000 });
  assert.equal(view.corrections(), 0);
  assert.deepEqual(view.maxLevels, []);
});
